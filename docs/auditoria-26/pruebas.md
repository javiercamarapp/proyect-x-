# Pruebas — auditoría 26

**Nota: 8/10** (antes 7). Razón del movimiento: **se atacó y subió**. Los seis
hallazgos abiertos de la 25 se re-midieron uno por uno con la mutación exacta
que cada uno describía: **cinco murieron de verdad** (no "se declaró cerrado":
rompí la función y la prueba se puso roja). El sexto —el bloque 50— quedó
arreglado y anclado, pero el arreglo cubrió **el bloque, no la clase**, y el
gemelo exacto sigue en el mismo archivo saliendo `✓ ok` con ocho mediciones sin
calificar. Eso es un cierre parcial, y lo reporto como REINCIDENTE. Contra eso:
la disciplina de esta ronda es la mejor medida hasta hoy —**124 commits, y solo
DOS tocan `src/` sin traer prueba** (los dos son ratchets de lint/baseline)—, y
las **11 mutaciones de código** que corrí sobre lo que la 25→26 arregló mataron
8 de 11.

Riesgo mayor del rubro, hoy: **las puertas siguen siendo el punto débil, no el
código.** El motor y la escritura del dinero están duros por cuarta ronda
seguida; lo que no puede reprobar es una fila de la batería SQL, y lo que no
tiene arnés son los escritores de la periferia (la jornada LFT, la descarga del
SAT) y el trinquete de cobertura, que hoy tolera que se borre el archivo de
pruebas del motor de cuadre sin ponerse rojo.

---

## Cómo se midió (para que se pueda repetir)

Todo corrió en un **worktree fuera del repo** (`git worktree add --detach` en el
scratchpad, `node_modules` por symlink) sobre `ce6f462`; el árbol vivo no se
tocó ni una vez. Al terminar: worktree borrado, `git worktree list` con una sola
entrada.

- **Suite completa**: 858 archivos, **11,275 pruebas**, 1 saltada, verde.
  113 s. (El repo tiene 861 `*.test.ts(x)` versados; vitest carga 858 — los
  otros 3 viven bajo rutas que el `exclude` filtra.)
- **Reloj**: la suite completa se corrió también con `TZ=Pacific/Kiritimati`
  (UTC+14) y `TZ=Pacific/Niue` (UTC−11). **858/858 verde en las tres.** No
  encontré una sola prueba sensible al huso.
- **Batería SQL contra Postgres REAL**: levanté un Postgres 16.13 efímero
  (`initdb`+`pg_ctl` en `/var/tmp`, apagado y borrado al terminar), apliqué
  `andamio_ci.sql` y **las 296 migraciones una por una, todas limpias sobre base
  virgen**, y corrí el runner real:
  **234 bloques · 230 ok · 0 fallos · 0 no-lanzó · 0 sin-calificar · 4 reportes.**
  Es la primera vez que esta batería se corre entera en una auditoría (la 25
  reprodujo un bloque suelto). La cadena `490d6b3 → b4f07c5 → 5cf4a9b →
  0e3cc2e` termina **verde de verdad**.
- **Cobertura medida** (la 25 la dejó pendiente): statements **82.70 %**,
  branches **72.59 %**, functions **86.02 %**, lines **85.34 %**.
- **15 mutaciones dirigidas** (11 de TypeScript sobre la suite completa, 2 de
  SQL contra el Postgres vivo, más las 6 re-mediciones de la 25): **11 muertas,
  4 sobrevivientes.**

### Re-medición de los hallazgos abiertos de la 25

| # | Mutación | Veredicto |
|---|---|---|
| V1 | `puedeFirmarLiquidacion` → `return false` (`revision.ts:91`) | **MUERTA** — `revision.test.ts:202` roja. Hallazgo **CERRADO** |
| V2 | `leerRevision().firmable` → `true` fijo (`revision.ts:340`) | **MUERTA** — 3 casos rojos. **CERRADO** |
| V3 | la póliza se exporta descuadrada: `> 0.01` → `> 1e9` (`poliza.ts:300`) | **MUERTA** — `poliza.test.ts` roja. **CERRADO** |
| V4 | la compuerta tolera 3 migraciones de atraso: `atras > 0` → `> 3` (`compuerta-deploy.mjs:140`) | **MUERTA** — «atrás = 1 — el único caso que ocurre» roja. **CERRADO** (reincidente de la 24 y la 25) |
| V5 | `graduarAgente()` | **BORRADA** con sus dos pruebas (`5e9597c`). **CERRADO** |
| V6 | `experimental: f.experimental === true` → `false` (`definiciones.ts:146`) | **MUERTA** — `definiciones.test.ts` roja con fila real. **CERRADO** |
| V7 | bloque 50 de la batería con sus cuatro valores mal | **ARREGLADO Y ANCLADO** … pero ver el ALTO de abajo: el gemelo del bloque 50 sigue vivo |

### Mutaciones nuevas

| # | Qué rompí | `archivo:línea` | Resultado |
|---|---|---|---|
| M1 | `proporcionCombustible15` acredita el IVA completo (el `?? 1` de antes de FIS-C1) | `fiscal.ts:525` | **muerta** (4 casos) |
| M2 | una nota de crédito vuelve a cruzarse como gasto | `sat_descarga/cruce.ts:102` | **muerta** |
| M3 | una nota de crédito vuelve a entrar por el intake 1:1 | `processor.ts:3050` | **muerta** (4 casos) |
| M4 | el ajuste del contralor NO se aplica al recálculo | `revision_recalculo.ts:93-95` | **muerta** |
| M5 | tras ajustar no se limpian los sellos de entrega (el chofer se queda con el PDF viejo) | `revision_recalculo.ts:207` | **muerta** |
| M6 | tras ajustar no se archiva el PDF que se va a sobrescribir | `revision_recalculo.ts:186` | **muerta** |
| M7 | un `update` de credenciales del SAT pierde su `.eq('tenant_id')` | `sat_descarga/escritura.ts:98` | **muerta** — la caza el escáner `consultas_admin_filtran_tenant.test.ts` |
| M8 | una flota con la descarga PAUSADA igual pide un rango al SAT | `sat_descarga/escritura.ts:157` | **SOBREVIVE** |
| M9 | la tool `clic` vuelve a saltarse el candado de emisión | `computer_use.ts:380` | **muerta** (3 casos) |
| M10 | un `invoice.payment_failed` reentregado vuelve a marcar 'fallida' una mensualidad cobrada | `saas/suscripcion.ts:861` | **muerta** (3 casos) |
| M11 | la factura de Stripe vuelve a nacer `metodo_cobro='transferencia'` | `saas/suscripcion.ts:897` | **muerta** |
| M12 | `anularAsiento` pierde su candado `is('anulado_en', null)` | `jornada/repo.ts:495` | **SOBREVIVE** |
| M13 | `contarConCfdi` devuelve **0** cuando la base falla, en vez de `null` | `facturacion/pendientes.ts:221` | **SOBREVIVE** |
| M14 | *(SQL, base viva)* `purgar_llm_costo` purga a **1 día** en vez de 13 meses | `mig. 0072 / purgar_llm_costo` | **SOBREVIVE** — bloque 47 sigue `✓ ok` |
| M15 | *(SQL, base viva)* `kpis_liquidacion_tenant` devuelve `montoComprobado = 0` | `mig. 0112` | **muerta** — bloque 89 pasa a `falla` con la clave señalada |

Lectura del mapa: **cero sobrevivientes en el motor, en el cuadre, en el ajuste
del contralor y en la facturación** (M1–M6, M9–M11 — cuarta ronda seguida). Los
cuatro sobrevivientes están, otra vez, en **una puerta que no puede reprobar**
(M14) y en **escritores de la periferia sin arnés** (M8, M12, M13).

---

## Hallazgos

### [ALTO · REINCIDENTE] El bloque 47 de `verificaciones.sql` sale `✓ ok` con OCHO de sus once mediciones sin calificar — el gemelo exacto del bloque 50, en el mismo archivo, sin tocar
`supabase/verificaciones.sql:2537` (el bloque) · `:2580` (el `raise`) ·
`scripts/ci/calificar-verificacion.mjs:87` y `:184-186` ·
`scripts/ci/calificar_verificacion_aud24.test.ts:119-123` (el ancla, que solo
mira el bloque 50)

**Mutación (medida contra Postgres real, no razonada):** en la base viva con las
296 migraciones, redefiní `purgar_llm_costo` para que purgue a **1 día** en vez
de 13 meses —la regresión textual que el bloque existe para impedir ("`llm_costo`
NO se purga… borrar sus filas haría que `resumen_costo_ia_tenant()` contestara,
sin avisar, una cifra MENOR para cualquier periodo purgado")—. El bloque 47
midió y reportó el desastre:

```
llm_costo INTACTA=0   crudo-de-meses-cerrados=0   idempotente=f
json={… "llmCostoPurgado": 87 …}
```

…y `calificar()` devolvió **`tipo: "ok"`**. El runner imprime
`✓ supabase/verificaciones.sql:2537` y `ci-postgres.yml` sale verde.

**La mecánica** es la del bloque 50, un piso más abajo: `partirEnClavesYEsperado`
corta el mensaje en el **primer** `(esperado`, y el `raise` del bloque 47 pone su
único `(esperado 100 / 100 / 10)` **a la mitad**, con **ocho `%` más después**.
Resultado: `izq` se queda con 3 claves, `der` se traga todo el resto como si
fuera el tercer valor esperado, ese valor trae espacios → `calificar()` lo
clasifica como prosa del autor (`:184`) → **comodín, `ok: true` incondicional**
(`:186`). Las tres claves cuadran con los tres esperados, así que ni siquiera cae
en `sin_calificar` (que sí sería rojo). Verificado también con el mensaje SANO:
las únicas dos mediciones que de verdad se comparan son `viejos-antes` y
`purgados`; `quedan`, `llm_costo INTACTA`, `consolidado`, `crudo-de-meses-
cerrados`, `mes-en-curso-NO-consolidado`, `idempotente`,
`plazo-minimo-falla-cerrado` y `sqlstate` son decoración.

**Por qué es REINCIDENTE y no un hallazgo nuevo:** el arreglo `66a08da` reescribió
el `raise` del bloque 50 y agregó una prueba que exige *que el bloque 50* traiga
un solo grupo `(esperado …)`. La pregunta que el hallazgo hacía era «¿puede un
bloque de esta batería salir ok con sus valores mal?», y la respuesta sigue
siendo sí. Barrí los 234 bloques con la función real buscando la firma exacta del
defecto —`%` después del marcador `(esperado`— y **el bloque 47 es el único que
queda**, con 8. Nada en el repo impide que vuelva a aparecer: la forma que el
calificador exige (un solo `(esperado …)`, **al final**) no está escrita en
ninguna prueba general.

**Consecuencia:** la garantía de la 0072 —"`llm_costo` no se purga; se consolida"—
se corre en cada push, imprime una palomita y no puede reprobar. `llm_costo` es
de dónde sale el costo de IA por flota que Javier mira en `/admin` y el precio
que va a ponerle a un cliente; el día que alguien "complete la purga" (que es el
modo de falla que el propio comentario del bloque anticipa, textual: "es la que
se rompería sola el día que alguien 'complete' la purga sin mirar quién lee la
tabla"), el panel enseñará un número distinto del mismo mes según cuándo se mire
y CI habrá dicho `✓` 234 veces. Y el equipo lee «234 bloques, 0 fallos» como si
los 234 aseveraran algo.

**Causa raíz probable:** el calificador supone un `(esperado …)` único **y al
final**; el arreglo de la 25 movió el del bloque 50 al final en vez de hacer que
esa forma se exija, y el bloque 47 nunca se miró.

*Refutación intentada: recorrí los 234 bloques (229 en `verificaciones.sql` + 5
en `capa1_auditoria_estatica.sql`) con `calificar()` real. 1,474 claves, 17
comodines (1.2 %). Los otros 16 son prosa legítima («la url», «nombra
uq_gasto_cfdi_uuid», «lo que suman 1000 filas») sobre claves cuyo valor de
verdad depende de datos. El mecanismo del comodín no está mal; el bloque 47 sí.
Y comprobé que la batería SÍ muerde donde está bien escrita: mutar
`kpis_liquidacion_tenant` para que devuelva `montoComprobado = 0` pone al
bloque 89 en `falla` con la clave exacta señalada (M15).*

### [MEDIO] El trinquete de cobertura tiene 3.6–7.3 puntos de holgura: borré los cuatro archivos de prueba más grandes —incluido el del motor de cuadre— y CI queda verde
`vitest.config.ts:120-123` (`lines: 78, statements: 78, branches: 69,
functions: 82`) · `.github/workflows/ci.yml:166` (`npm run test:coverage`)

**Mutación:** borré `src/lib/likida/cuadre/engine.test.ts` (1,674 líneas),
`src/lib/likida/agentes/runner.test.ts` (1,363),
`src/app/api/cron/facturar/route.test.ts` (1,286) y
`src/lib/admin/negocio.test.ts` (1,096) —**5,419 líneas de prueba, 369 casos**,
entre ellas la del motor que calcula la liquidación y la del único módulo con
permiso de cruzar tenants— y corrí `npx vitest run --coverage`:

```
sin borrar : statements 82.70  branches 72.59  functions 86.02  lines 85.34
tras borrar: statements 81.12  branches 71.40  functions 84.83  lines 83.68
umbral     :             78                69                82           78
```

**exit 0.** La puerta ni se inmuta.

**Consecuencia:** el comentario que vive encima de esos umbrales dice, textual,
«UN TRINQUETE, NO UNA ASPIRACIÓN … se reancla el trinquete a ese baseline
medido, con margen menor a un punto». Ese margen se reancló el 24-ago; hoy son
3.6 puntos en la métrica más apretada (branches) y 7.3 en la más floja (lines).
Traducido a la regresión realista, que no es borrar pruebas sino no escribirlas:
**caben ~1,750 líneas nuevas de código sin una sola prueba antes de que la puerta
se ponga roja** (24,659/(33,968+X) = 0.69). El trinquete que la ronda 5 puso
para que «989 pruebas» dejara de medir esfuerzo volvió a medir esfuerzo.

**Causa raíz probable:** el trinquete se sube a mano y nadie lo reancló en las
tres rondas en que la cobertura subió sola; no hay nada que avise cuando la
holgura pasa del punto declarado.

### [MEDIO] La mitad de ESCRITURA del registro de jornada (LFT 132-XXXIV) no tiene una sola prueba: `anularAsiento` puede perder su candado de idempotencia y la suite queda verde
`src/lib/likida/jornada/repo.ts:495` · llamada en
`src/app/dashboard/jornada/page.tsx:205`

**Mutación:** borro la línea `.is('anulado_en', null)` del `update` de
`anularAsiento`. Corro **la suite completa**: 858 archivos, 11,275 casos, **0
fallos**.

Con esa mutación desaparece exactamente lo que el comentario de arriba (`:472`)
promete: «Anclada al tenant Y a `anulado_en is null`: anular dos veces no
reescribe la primera anulación con otro autor». La segunda anulación pisa el
autor, la hora y el motivo de la primera — y este registro es el que la LFT 132
fr. XXXIV, párrafo tercero, llama «prueba plena si se acredita que fue
acordado». Un rastro de auditoría laboral que se puede reescribir en silencio no
es prueba plena de nada.

No es un hueco aislado: de los 15 exportados de `jornada/repo.ts`, **`idDeJornada`,
`jornadaQueCierra`, `catalogoDeOperadores`, `asientosDeJornada`, `anularAsiento`,
`cerrarDia` y `sellarConformidad` no aparecen nombrados en ningún `*.test.ts`
del repo** — y `asientosDeJornada` la llama `processor.ts:944`, o sea que está
en el camino de WhatsApp. Los dos archivos que tocan el módulo
(`orden-asientos.test.ts`, `api/export/jornada/route.test.ts`) prueban el orden y
el export, nunca las escrituras.

**Causa raíz probable:** el módulo se probó por donde se leía (el export, el
orden de los asientos) y las escrituras quedaron del otro lado de la frontera —
el mismo patrón exacto que la 25 documentó para `revision_panel.test.tsx` vs.
`leerRevision`.

### [MEDIO] `contarConCfdi` puede devolver **0** cuando la base falla —una cifra inventada en pantalla— y nada se pone rojo
`src/lib/likida/facturacion/pendientes.ts:221` · consumida en
`src/app/dashboard/agentes/facturas/page.tsx:48`

**Mutación:** en la rama de error, cambio `return null;` por `return 0;`. Suite
completa: **858/858 verde, 0 fallos**.

El comentario de la función dice, textual: «`null` ≠ 0: si no se pudo contar, se
dice» (`:211`). Y la página que la consume declara, tres líneas arriba de la
llamada: «Sin catch: base caída = página caída, no una lista vacía que afirma
"todo facturado" estando ciega. El contador degrada solo (null = se dice)». Con
la mutación, una lectura caída se convierte en un **0 con pinta de medición** en
la tarjeta de gastos con CFDI de `/dashboard/agentes/facturas`: el contralor lee
«0 con CFDI» y sale a reclamarle a su equipo por un mes de facturas que sí
existen. Es la regla que define al producto —«nunca inventar una cifra»— sin un
solo `expect` que la sostenga en esta función.

`pendientes.ts` sí tiene pruebas (`armar`, `validarUuidCfdi`, `getPorFacturar`);
lo que no tiene es el contador y su fail-closed.

**Causa raíz probable:** el `?? null` se escribió con su justificación en prosa y
sin un caso que lo fije, igual que la lista `FIRMA` del hallazgo ALTO de la 25.

### [BAJO] `sat_descarga/escritura.ts` —211 líneas, tres server actions sobre el circuito fiscal— no tiene un solo archivo de prueba
`src/lib/likida/sat_descarga/escritura.ts:157` · consumida en
`src/app/dashboard/descarga-sat/vista.tsx:126`

**Mutación:** cambio
`if (!cfg.activa) return { ok: false, mensaje: 'La descarga está pausada…' }`
por `if (false) …`. Suite completa: **858/858 verde**.

Con eso, una flota con la descarga **pausada a propósito** sigue abriendo
solicitudes ante el SAT desde el botón de «pedir un rango a mano» — y el propio
mensaje de la función de al lado explica el costo: «reintentarlo consume el tope
diario del RFC». Cero pruebas nombran `guardarConfigDescarga`,
`verificarCredencial` ni `pedirRangoManual`; la validación del RFC, el tope de
`VENTANA_MAX_DIAS`, la coherencia de fechas y la distinción entre el rebote del
candado (`23505`/`23P01`) y «la base no respondió» viven sin arnés.

Lo pongo en BAJO y no en MEDIO por una razón medida: la parte que de verdad
podía hacer daño —el `update` sin `.eq('tenant_id')`, que habría nulificado el
certificado de TODAS las flotas— **sí la caza** el escáner estático
`supabase/pruebas-aislamiento/consultas_admin_filtran_tenant.test.ts` (M7,
muerta). Lo que queda sin red es la lógica de negocio del módulo.

**Causa raíz probable:** el módulo nació como «server actions de una pantalla» y
las pantallas están exentas de la medición de cobertura (`vitest.config.ts`
excluye `src/app/**/*.tsx`); el archivo vive en `lib/`, pero nadie escribió su
prueba y la puerta de cobertura no lo notó por la holgura del hallazgo anterior.

---

## Lo que revisé y está bien

- **Cinco de los seis hallazgos abiertos de la 25 están cerrados DE VERDAD, no
  declarados.** Los rompí uno por uno (V1–V6) y las pruebas se ponen rojas. Vale
  la pena nombrar dos: `revision.test.ts` pasó de 255 a ~380 líneas y ahora
  cubre las dos mitades (autorización y `firmable`) con los casos de borde que
  el hallazgo pedía —"rechazada nunca firmable", "cuadró sola: firmable",
  "ya la firmó una persona: no"—; y la compuerta de despliegue por fin tiene
  el caso `atrás = 1` con su nombre completo en el `it` («el único caso que
  ocurre en la vida real»), tras dos rondas reincidiendo.
- **La disciplina de commit es la mejor medida hasta hoy.** De los 124 commits
  de esta ronda, **solo dos tocan `src/` sin traer un `*.test.ts`**, y los dos
  son ratchets de baseline (`846aa11` lint, `690e0af` límite-sin-orden). No
  encontré un solo arreglo de producto sin prueba acompañante.
- **La cadena de "arreglos del arreglo" es una buena señal, no una mala.**
  `490d6b3 → b4f07c5 → 5cf4a9b → 0e3cc2e` la fue encontrando **CI real** cada
  vez: los cuatro fallos entraron por `ERROR INESPERADO (no llegó al RAISE)`,
  que el runner cuenta como fallo duro. Es exactamente la puerta funcionando —
  cuatro fixtures que chocaban contra restricciones reales (`uq_viaje_abierto_por_operador`,
  `factura_saas_una_por_periodo`, el filtro de `revision` de la 0308, `app_user.id`
  sin default) y ninguna de las cuatro pasó en verde midiendo mal. Corrí la
  batería entera contra Postgres 16.13 real con las 296 migraciones: **0 fallos,
  0 sin-calificar.**
- **Las 296 migraciones aplican limpias sobre base virgen, una por una.** No
  falló ninguna.
- **El motor, el cuadre, el ajuste y la facturación siguen duros — cuarta ronda
  seguida sin un sobreviviente.** M1 (el 15 % del diésel en efectivo volviendo a
  acreditar el IVA completo), M2/M3 (la nota de crédito entrando como gasto por
  las dos puertas), M4/M5/M6 (el ajuste del contralor sin aplicarse, sin limpiar
  los sellos de entrega, sin archivar el PDF que sustituye), M9 (la tool `clic`
  saltándose el candado de emisión), M10/M11 (el webhook de Stripe): las once
  mueren, varias en varios casos a la vez.
- **La suite no depende del reloj ni del huso.** 858/858 verde bajo UTC+14 y
  UTC−11, además del huso local. No reproduje ninguna intermitencia en cuatro
  corridas completas del mismo árbol.
- **`pruebas-manuales/` sigue sin poder colarse.** 25 archivos `*.prueba.ts`,
  todos fuera del `include` por defecto de vitest; `vitest.config.ts` solo
  agrega excludes. Ninguno se corrió, ni siquiera bajo `--coverage`. Lo mismo
  `vitest.audit.config.ts` y `vitest.qa.config.ts`: ningún workflow los invoca.
- **El escáner de aislamiento por tenant SÍ muerde.** M7 (un `update` de
  credenciales del SAT sin `.eq('tenant_id')`) muere en
  `consultas_admin_filtran_tenant.test.ts`, que barre por catálogo y no por
  lista escrita a mano.
- **El `ignoreCommand` de `vercel.json` está anclado byte a byte**
  (`compuerta_deploy_aud24.test.ts:166`), inversión de exit incluida — que es la
  mitad del mecanismo que nadie mira.
- **El trinquete de lint es más fuerte de lo que aparenta**: no solo capa el
  total, capa **por archivo y por regla** (`lint-ratchet.mjs:58-60`), así que
  arreglar un warning en un archivo no compra permiso para meter otro en otro.
- **El mecanismo de EXENTAS de `migraciones_verificadas.test.ts` sigue exigiendo
  razón escrita** (≥20 caracteres) y prohíbe nombrar migraciones que ya no
  existen. Las 15 entradas nuevas de esta ronda traen párrafo con el criterio y
  el archivo de prueba que las reemplaza, no una lista de silencio.

---

## Lo que NO alcancé a revisar

- **No probé la Capa 0 (`supabase/tests/wa_leases_fencing.sql`, pgTAP)** ni
  `scripts/ci/e2e/`, `playwright-smoke.mjs` ni `e2e-navegador.yml`: `pg_prove` y
  `postgresql-16-pgtap` no están instalados aquí y el navegador no aplica. Es la
  tercera ronda seguida que quedan fuera; alguien tendría que mutarles algo una
  vez.
- **La batería SQL la corrí una sola vez, y solo mutué DOS de sus 234 bloques**
  (el 47 y el 89). Mi barrido de los otros 232 sigue siendo la comparación
  estática con `calificar()` real: sé que ninguno más tiene la firma del defecto
  del bloque 47, y sé que ninguno cae en `sin_calificar`; **no** sé si alguno
  mide algo vacuo (por ejemplo, sembrar cero filas y afirmar `0 = 0`). Esa clase
  solo se caza mutando el producto bloque por bloque, y son 234.
- **No medí cobertura POR ARCHIVO**, solo el resumen global. El mapa de zonas
  con 0 % de líneas ejecutadas sigue sin actualizarse desde la ronda 5; el
  reporte HTML quedó en la caché del worktree, que borré. Mi sustituto fue el
  barrido de nombres: **222 funciones exportadas de `lib/likida`, `lib/admin` y
  `lib/saas` cuyo identificador no aparece en ningún archivo de prueba** (eran
  ~275 en la 25 con un alcance parecido, así que bajó). Es una pista, no una
  medición: una función puede estar bien cubierta *a través de* otra.
- **No revisé `supabase/tests/` ni los workflows `salud-produccion.yml`,
  `rollback-production.yml`, `backup-storage.yml`** más allá de leerlos.
- **El árbol se movió debajo de mí**: arranqué en `ce6f462` y terminé en
  `8abb596` (cuatro commits de fiscal y frontend de otros rubros). Verifiqué que
  ninguno toca los archivos de mis cinco hallazgos, pero todas mis cifras de
  "verde" son de `ce6f462`.

---

## Árbol limpio

```
$ git status --porcelain
(vacío)
$ git worktree list
/home/user/cuadra  8abb596 [claude/auditoria-26]
```

Todas las mutaciones (11 de TypeScript, 1 borrado de 4 archivos de prueba)
corrieron en un `git worktree --detach` bajo el scratchpad, que quedó **borrado**
(`git worktree remove --force`). El Postgres 16.13 vivió en `/var/tmp/pgverif26`,
se detuvo con `pg_ctl stop` y se borró con su directorio; las dos mutaciones de
SQL (`purgar_llm_costo`, `kpis_liquidacion_tenant`) se aplicaron solo dentro de
esa base efímera y la segunda se restauró antes de apagarla. Los scripts de
sonda viven en el scratchpad, fuera del repo. **No toqué ni un archivo del árbol
de trabajo**; el único que este rubro agrega es
`docs/auditoria-26/pruebas.md`.
