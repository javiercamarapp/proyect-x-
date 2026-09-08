# Arquitectura y mantenibilidad — auditoría 29

**Nota: 4/10** (antes 3). Razón del movimiento: **se atacó y subió**. Los dos
motivos por los que la 28 bajó de 4 a 3 están cerrados, verificados abriendo el
archivo y la prueba, no creyéndole al asunto del commit:

1. **El camino concreto por el que el producto hacía algo mal y nadie se
   enteraba** —la lectura sin cota de líneas ECC en el motor del dinero— ya no
   existe. `desde_db.ts:253-289` pagina con `traerTodo` + `order('fecha').
   order('id')` + `range`, y **lanza** `LecturaIncompleta` en vez de devolver una
   lectura parcial con cara de completa. La prueba que lo ancla
   (`desde_db_ecc_paginacion.test.ts`) simula el `max_rows` de PostgREST de
   verdad (`:88`, el fallback a `0..999` cuando no hay `.range`), pone la línea
   que empareja en la fila **#1,500**, y trae **prueba negativa de control**
   (`:152-171`): si el `ticket_monedero` viniera de una coincidencia accidental,
   ese tercer caso no pasaría. Revertir `desde_db.ts` la pone roja. Cierre real.
2. **Los guardias que medían la unidad equivocada.** `frontera_datos_guardiana.
   test.ts:74` ahora tiene un segundo techo sobre **llamadas**, no archivos
   (`TECHO_LLAMADAS_FUERA_DE_LA_FRONTERA = 1_328`). Reconstruí el barrido con su
   mismo criterio: **252 archivos / 1,284 llamadas** hoy. La propiedad que
   CLAUDE.md declara sigue cubriendo el 3.9 % del acceso, pero **ya existe un
   instrumento que ve crecer el otro 96 %**, que era el hallazgo.

Y una corrección a mi propia medición de la 28, que hay que decir: escribí
«8 ciclos de importación reales, el mayor de seis módulos». **Eran un artefacto
de medición mío**: mi grafo contaba `import type`, que TypeScript borra al
compilar. Con los `import type` fuera —el grafo que de verdad se ejecuta— son
**6 ciclos, el mayor de 5**, y son **exactamente los mismos** en `c7bbb83` y en
`HEAD` (medido con el mismo script sobre los dos árboles). Ninguno evalúa un
binding del socio en el cuerpo del módulo, que era el trabajo que la 28 dejó
pendiente sobre este tema. No hay regresión de ciclos en esta ventana.

No sube más de 4 por dos cosas, ninguna nueva: el **CRÍTICO va en su 7ª
aparición** desde la 24, byte por byte igual, y el ancla del rubro —«4 o menos si
la misma lógica de dinero vive en más de un archivo»— sigue siendo literalmente
cierta: el predicado «esto es combustible del ejercicio» vive en **cinco**
implementaciones (`engine.ts:706`, `fiscal.ts:715`, `desde_db.ts:175`,
`0345:24`, `0317:139`), igual que en la 26, la 27 y la 28.

**El riesgo mayor del rubro, hoy:** la ventana creó **copias nuevas de la misma
verdad en la frontera TypeScript↔SQL**, donde ningún guardia mira: el techo de
reintentos del inbox de WhatsApp (`MAX_INTENTOS_PENDIENTE = 5` contra cuatro
`intentos < 5` literales en la 0325) y el plazo de conservación de la telemetría
(180/365 en la prosa del aviso de privacidad contra cinco literales SQL). Las dos
las escribieron commits de arreglo de la 28, y en las dos el comentario del
código **afirma** un acoplamiento que no existe.

> **Método.** Todo se midió en esta ronda contra `7bcc319` (HEAD de
> `claude/auditoria-29`), con scripts propios sobre el árbol y sobre `c7bbb83`
> extraído con `git archive` a un directorio temporal fuera del repo — no
> recordado, y comparando los dos árboles con el MISMO script. `npx tsc --noEmit
> -p .` → **exit 0**. Corrí los guardias estructurales
> (`frontera_datos_guardiana`, `tope_consulta`, `contencion_listas`,
> `rol_label_unico`, `fiscal_agregado_15pct`, `sin_importar_app`,
> `etiquetas_sincronizadas`, `normas_sincronizadas`, `desde_db_ecc_paginacion`):
> **9 archivos, 62 pruebas, todas verdes**. Inventario medido hoy: **386,878**
> líneas TS/TSX en `src/` (1,725 archivos), **933** archivos de prueba
> (`find src scripts -name '*.test.ts*'`). No edité ningún archivo del repo fuera
> de este documento. La base está en cero y no hay credenciales: la aritmética de
> los escenarios es aritmética sobre el SQL y el TypeScript leídos.

---

## Estado de los hallazgos abiertos de la 28

Abrí uno por uno el archivo y la prueba, y en cada caso pregunté si la prueba
fallaría con el arreglo revertido.

| ID | Hallazgo de la 28 | Veredicto hoy | Evidencia |
|---|---|---|---|
| **ARQ-C1** (CRÍT.) | La póliza tras `ajustar` inhabilita el export contable del periodo completo | **REINCIDENTE — 7ª aparición** | `git diff c7bbb83..HEAD -- src/app/api/export/poliza/ src/lib/likida/contabilidad/ src/lib/likida/revision_recalculo.ts` → **vacío**. `ajustesIncompatibles` sigue en `route.ts:117`, el bucle en `:364`, el 409 del periodo entero en `:394-406`. Ver hallazgo abajo |
| ARQ-A1/A2 (ALTO) | `lineasEccParaCuadre` sin cota: a 1,000 filas apaga un control fiscal | **CERRADO** | `desde_db.ts:265-289` (`traerTodo`+`order`+`range`+`LecturaIncompleta`); prueba con control negativo en `desde_db_ecc_paginacion.test.ts:114-171`, que imita `max_rows` en `:88` |
| ARQ-M1a (ALTO) | El guardia de la frontera cuenta ARCHIVOS y está saturado | **CERRADO** | `frontera_datos_guardiana.test.ts:74`, `:148`, `:158-169`. Medido hoy: 252 archivos / **1,284 llamadas** de un techo de 1,328 |
| ARQ-M1b (MEDIO) | `CAMINO_DEL_CIERRE` = lista literal de 4; `processor.ts` fuera | **MUTADO** | La lista creció a 6 (`tope_consulta.test.ts:37-44`) y `processor.ts:172/176` sí lleva `acotada`. La causa raíz —lista literal— sigue: **6 de 73** archivos con consulta cruda, y `tools.ts:412` queda fuera. Ver ARQ-M1 abajo |
| ARQ-M3 (MEDIO) | «¿Este destino es interno?» con dos implementaciones | **CERRADO** | `esIpPrivada` borrada; `investigador.ts:176-185` delega en `hostNoPublico`/`esIpPublica` de `lib/http/destino_publico.ts`. `grep esIpPrivada src` → 0 |
| ARQ-B1 (BAJO) | Tres dependencias invertidas, una invisible al grep (`import()`) | **CERRADO** | Handler extraído a `lib/admin/calcom_webhook.ts`; `route.ts` es 9 líneas que re-exportan `POST`. Grafo medido hoy: **2** invertidas `lib→app`, las dos listadas. Guardia nuevo `sin_importar_app.test.ts:31` que **sí** ve `import()` dinámico |
| ARQ-A4 (ALTO) | `proporcionCombustible15` declara «al centavo» una estimación | **CERRADO** | `fiscal.ts:528-555`: la nota ahora separa monto (exacto) de IVA (estimación), con el ejemplo verificado $15,900.38 vs $17,496.81/$14,303.96 y la decisión pendiente declarada |
| ARQ-A5 (ALTO) | `leerValorDelMes` manda el IVA del mes sin filtrar `revision` | **CERRADO** | `exito.ts:718` trae `revision` en el `select`; `:678-683` declara la población («solo firmadas») en cada renglón de dinero |
| ARQ-B2 (BAJO) | `estadoRenglon` reconstruye `cubetaDe` sin llamarla | **CERRADO** | `dashboard/[id]/vista.tsx:6` importa `cubetaDe` y `:182-184` lo dice; `TIPOS_MALOS`/`TIPOS_POR_CONFIRMAR` borrados; prueba de paridad en `estado_renglon.test.ts` |
| ARQ-B4 (BAJO) | El encabezado de `revision.ts` declara dos contratos que rompe | **CERRADO** | `revision.ts:9-33`: separa escritor único (vigilado por `revision_escritor_unico.test.ts`) de los **siete** lectores, nombrados |
| ARQ-B5 (BAJO) | `ROL_BADGE`, la quinta copia del dominio de roles | **CERRADO** | `chrome.tsx:9` lo importa de `lib/auth/provisionar`; `chrome_rol_badge.test.tsx:59` prohíbe que vuelva a declararse ahí |
| — (ALTO, de la 27) | «Una foto repetida no es un gasto» no existe en los agregados SQL del cubo del 15 % | **REINCIDENTE** | `grep -c "folio_norm\|distinct" 0345…sql 0317…sql` → **0 y 0**. En TS es fuente única (`copiasDeComprobante`, 6 llamadores); en SQL no existe |
| — (MEDIO, de la 27) | El predicado «combustible del ejercicio» en cinco implementaciones | **REINCIDENTE** | Las cinco vivas y sin cambios: `0345:24`, `0317:139`, `engine.ts:706`, `fiscal.ts:715`, `desde_db.ts:175` |
| — (BAJO, 6ª ronda) | `procesarTurno` | **REINCIDENTE y peor** | `processor.ts:1554`→`4990` = **3,436 líneas** (eran 3,253 en la 27 y la 28). Volvió a crecer: **+183** |

**Cierre acreditable: 9 de 14.** Es, con diferencia, la mejor ventana de este
rubro desde que existe el tablero. Lo que no se cerró es lo que exige una
decisión de producto (ARQ-C1) o una migración (el predicado en SQL).

---

## Hallazgos

### [CRÍTICO · REINCIDENTE, 7ª aparición desde la 24] ARQ-C1 — un ajuste firmado sigue tirando el export contable del PERIODO COMPLETO, y el código no se tocó ni un carácter

`src/app/api/export/poliza/route.ts:117-131` (`ajustesIncompatibles`) ·
`:364-368` (dónde entra al bucle, `bloqueos.push` + `continue`) · `:394-406`
(el 409 `polizas_incompletas` que tira las 40, no la 1) ·
`src/lib/likida/revision_recalculo.ts:56-58` (el ajuste solo cambia `monto`) ·
`supabase/migrations/0306_…:32` («*Lo que NO se toca:
`gasto.sub_total`/`iva_traslado`/`ieps_traslado`*»).

**Verificación de hoy, primero.** `git diff c7bbb83..HEAD --stat --
src/app/api/export/poliza/ src/lib/likida/contabilidad/
src/lib/likida/revision_recalculo.ts supabase/migrations/` devuelve **una sola
línea, y es `NUMERACION-SALTADA.md`**. Los números de línea que la 28 citó
(`:117`, `:364`) siguen apuntando exactamente a lo mismo. Ningún commit de los 43
tocó este camino.

**Escenario, con valores.** Marzo de 2026, 40 liquidaciones cerradas y firmadas.
En la V-0912 el OCR leyó un hospedaje como **$1,480** cuando el ticket dice
**$5,480**; el contralor usa «ajustar» —el botón que el producto vende como su
corrección insignia— y firma. La 0306 mueve `gasto.monto` a 5,480 y **conserva**
`sub_total = 1,275.86`, `iva_traslado = 204.14`, `ieps = 0`. Al exportar la
póliza del mes, `ajustesIncompatibles` calcula
`totalFiscal = 1,275.86 − 0 + 204.14 + 0 = 1,480.00`, ve `|5,480 − 1,480| =
4,000 > 0.01`, y devuelve un bloqueo. `:364` lo empuja a `bloqueos` y `:394`
contesta **409 `polizas_incompletas`** con el texto «1 de 40 liquidaciones no se
pueden asentar. No se exporta el archivo a medias». **Las 39 sanas tampoco
salen**, hoy ni ningún otro día: nada en el producto convierte esa fila en
exportable, porque la mitad fiscal del comprobante no se recaptura por ninguna
pantalla. El mensaje además le pide al contralor «corrige los datos del
comprobante», y el comprobante está bien: lo que está mal es el `monto` que él
mismo corrigió a propósito.

**Consecuencia.** El contralor no puede cerrar el mes en su ERP, y la causa es
haber usado la función que el demo enseña. Para el equipo: la 24 escribió que
esto «exige decidir qué hace el producto con una liquidación ajustada», la 27
documentó que la decisión se tomó **implícitamente** dentro de un commit fiscal
y en la dirección que rompe el entregable, la 28 lo confirmó, y en la ventana más
grande del proyecto —43 commits, 222 archivos— nadie abrió el archivo. Un
hallazgo que sobrevive siete rondas deja de ser deuda técnica y pasa a ser
evidencia de que el tablero no gobierna la prioridad.

**Causa raíz probable:** no hay una decisión de producto escrita sobre qué es la
póliza de un comprobante cuyo `monto` firmado y cuyo desglose fiscal no cuadran;
`ajustesIncompatibles` toma la más conservadora (no asentar) y la aplica al
periodo, que es la granularidad equivocada para una decisión por comprobante.

---

### [ALTO] ARQ-A1 — el techo de reintentos del inbox de WhatsApp vive en TypeScript y en SQL, y el comentario del código afirma que están atados

`src/lib/likida/wa_pendientes.ts:26` (`export const MAX_INTENTOS_PENDIENTE = 5`)
· `src/lib/likida/conv.ts:12` (lo importa) y `:1012`
(`if (fila.intentos < MAX_INTENTOS_PENDIENTE) { vivas++; continue; }`) ·
`src/lib/likida/processor.ts:4085-4089` (el comentario: «*son INVISIBLES para el
cron (`listar_wa_pendientes`/`reclamar_wa_pendiente` filtran `intentos < MAX`)*»)
· `supabase/migrations/0325_capacidad_wa_jornada_timezone.sql:27` (el índice
parcial `where procesado_en is null and intentos < 5`), `:56`
(`listar_wa_pendientes`), `:96` y `:103` (`reclamar_wa_pendiente`) ·
`src/lib/likida/aviso_barrera_cerrado.test.ts:73` (una **tercera** copia:
`MAX_INTENTOS_PENDIENTE: 5` escrito a mano dentro de un mock).

**Escenario, con valores.** Un mantenedor sube el techo de 5 a 8 en
`wa_pendientes.ts:26` —un cambio de un carácter, plausible: darle más
oportunidades a un OCR que falla por red—. Un chofer mandó la foto de un ticket
de diésel de **$9,400** que lleva `intentos = 6`. A partir de ese deploy:

- `conv.ts:1012` la cuenta como **viva** (`6 < 8`), así que
  `fotoAnteriorSinProcesar` devuelve `{ vivas: 1, muertas: [] }`;
- `processor.ts` (la rama BE-A3 de `:4078`) **aplaza** el cierre y le contesta
  al chofer que todavía está leyendo una foto anterior;
- del lado de Postgres, el índice parcial de `0325:27` **no contiene la fila**
  (`6 < 5` es falso), `listar_wa_pendientes` la filtra en `:56` y
  `reclamar_wa_pendiente` la rechaza en `:96`. El cron **nunca** vuelve a
  tomarla.

Entra «listo» → sale un aplazamiento perpetuo: cada vuelta del cron repite la
espera, la rama de carta muerta (`processor.ts:4090`) **no** se dispara porque
`muertas` viene vacío, y la fila solo desaparece con la purga a 90 días
(`0155:158`, que también dice `intentos >= 5` a mano). El viaje de ese chofer no
cierra, y todo lo que venga detrás —fotos nuevas, viajes nuevos— se queda atrás
de él. Ninguna prueba se pone roja: `wa_pendientes_carta_muerta.test.ts:48`
compara contra la **misma constante importada**, y `aviso_barrera_cerrado.
test.ts:73` tiene el 5 escrito a mano en su mock.

**Consecuencia.** Un chofer al que el producto le afirma, en cada mensaje, que
está leyendo una foto que ningún código va a leer — la regla «un rótulo tiene que
ser verdad» rota por un cambio de una línea, en el camino caliente, sin señal.
Y para el equipo: el comentario de `processor.ts:4088` es lo peor de todo, porque
**documenta el acoplamiento como si existiera** («filtran `intentos < MAX`»);
quien lea el código antes de tocar la constante va a creer que el cambio está
cubierto.

**Intento de refutación.** (a) ¿Existe un guardia SQL↔TS? Barrí los 933 archivos
de prueba: `migraciones_verificadas.test.ts` menciona la 0325 solo para declarar
que sus contratos se prueban en `supabase/tests/*.sql` (que aquí no corren, sin
Postgres), y ninguna prueba lee `0325*.sql` para cotejar el 5. (b) ¿Bajar la
constante sería inocuo? No, es peor en el otro sentido: con `MAX = 3`, una fila
con `intentos = 4` se declara **muerta** en TS y se sella con
`descartarCartaMuerta`, mientras el cron —que la ve viva— compite por ella. (c)
¿Es el mismo hallazgo que el del 15 %? No: aquél es un predicado fiscal
reimplementado; éste es un número que se puso en TS **en esta ventana** (el
módulo `wa_pendientes.ts` y su importación desde `conv.ts` son la arista nueva
que el commit `553a767` agregó) sobre un literal SQL que ya llevaba meses ahí.

**Causa raíz probable:** el arreglo de BE-A3 necesitaba nombrar el techo desde
TypeScript para distinguir viva de muerta, y lo declaró en vez de derivarlo —
no hay forma barata de leer un literal de un `where` de una migración, y nadie
puso el guardia que compare los dos textos.

---

### [ALTO] ARQ-A2 — «qué régimen SAT abre la facilidad del 15 %» se decide en tres lugares, y la ficha que dice cuál es el impacto de la norma no nombra a ninguno

`src/lib/likida/perfil/onboarding.ts:14` (`CLAVES_REGIMEN_SAT`) y `:19-22`
(`regimenElegibleDeClave`, **creada en esta ventana** por `9aefea0`, el arreglo
del CRÍTICO fiscal) · `src/lib/likida/perfil/entrevista.ts:598` (la misma lista
de seis claves, otra vez) y `:713` (`const elegible = v === '612' || v ===
'624'`, en línea) · `src/lib/likida/administracion.ts:200-201`
(`const REGIMENES_ELEGIBLES = ['624', '612']`, dentro de `crearFlota`) ·
`src/app/admin/flotas/page.tsx:240` (un `<select>` sí/no que lo fija a mano, sin
clave SAT) · `normas/rfa-2026-2.9.yaml:84-91` (`usado_en_codigo`) ·
`normas/README.md:51-52` («*`usado_en_codigo` apunta a los archivos y líneas que
dependen de la ficha. **Si cambias la norma, ese es tu impacto**.*») ·
`src/lib/likida/normas/normas_sincronizadas.test.ts:230-244` y `:270-288` (el
guardia).

**La medición.** `usado_en_codigo` de la ficha 2.9 lista **siete** entradas:
`cuadre/engine.ts` (×3), `repo.ts`, `cuadre/desde_db.ts`,
`periodo/combustible.ts` y `fiscal.ts`. **Las siete CONSUMEN la bandera de
elegibilidad; ninguna la DECIDE.** Los tres sitios que la deciden no aparecen. Y
el commit `99fba32` de esta ventana **editó ese mismo campo** («*se corrige para
citar los símbolos vivos del 15 %*») sin agregarlos.

**Escenario, con valores.** Febrero de 2027: la RFA se republica —el propio
`normas/README.md:53-54` dice que hay que revisar las fichas `rfa` en cada
ejercicio— y la 2.9 pasa a admitir también el régimen **626 (RESICO)**. El
mantenedor abre `normas/rfa-2026-2.9.yaml`, lee `usado_en_codigo`, y toca los
cinco archivos que ahí aparecen. `npx vitest run normas_sincronizadas` queda en
verde: el guardia solo comprueba que **lo listado exista** (`:236` la ruta,
`:280` el símbolo), nunca que lo que usa la norma **esté listado**. Nadie toca
`onboarding.ts:21`, `entrevista.ts:713` ni `administracion.ts:200`, que siguen
diciendo `'612' || '624'`.

Resultado, con una flota RESICO real: régimen `626`, dedicación exclusiva a
carga, ejercicio con **$1,200,000** de combustible y **$200,000** pagados en
efectivo. Con la facilidad, el tope es `0.15 × 1,200,000 = $180,000`: se deducen
$180,000 y solo $20,000 caen en `efectivo_sobre_15`. Sin ella —lo que los tres
deciders siguen escribiendo en `regimenElegible: false`— los **$200,000** enteros
caen en `combustible_efectivo`, que está en `SIN_IVA_ACREDITABLE`: se pierde la
deducción de $180,000 **y** los ~$28,800 de IVA acreditable que la norma nueva sí
concede. El panel del contador, que el mantenedor sí actualizó, afirma que la
regla la cubre.

**Consecuencia.** Para la flota: $208,800 de diferencia fiscal decididos por
cuál de las cuatro puertas de alta usó (formulario web, entrevista de WhatsApp,
`/admin` → `crearFlota`, o el `<select>` sí/no de `/admin/flotas`). Para el
equipo: el mecanismo que el repo construyó para responder «si cambia la norma,
qué toco» es **ciego por construcción en la dirección que importa**, y lo es
justo sobre la regla que sostiene el número más grande del producto.

**Intento de refutación.** (a) ¿Divergen HOY? **No** — probé las tres con `601`,
`612`, `624` y `626` y las tres coinciden. Es un hallazgo de acoplamiento, no un
bug vivo, y por eso es ALTO y no CRÍTICO. (b) ¿El arreglo de la 28 no unificó
esto? Unificó la **precedencia** (`facilidad15Vigente`, `preguntas.ts:362`, que
sí reemplazó cuatro copias) — no el **predicado sobre la clave SAT**, que es otra
pregunta. (c) ¿Se sabía? Sí, y peor: `normas/rfa-2026-2.5.yaml` nombra
`REGIMENES_ELEGIBLES = ['624','612']` de `administracion.ts` en su prosa
(`impacto_en_producto`), pero su propio `usado_en_codigo` es `[]` — la referencia
está en el campo que ningún guardia lee. (d) ¿El comentario de `onboarding.ts:16`
no basta? Dice «*Mismo cálculo que `entrevista.ts:704`*»: documenta la copia y la
deja, con un número de línea que ya se desplazó a `:713`.

**Causa raíz probable:** el arreglo del CRÍTICO fiscal extrajo la función
correcta y la cableó a **un** llamador (la mitad que el hallazgo citaba), en vez
de migrar los tres; y `usado_en_codigo` se mantiene a mano con un guardia que
solo puede detectar podredumbre, no omisión.

---

### [MEDIO] ARQ-M1 — «ninguna consulta del cierre se queda sin techo» sigue siendo una lista literal, ahora de 6 sobre 73, y quien sube el PDF del cierre está fuera

`src/lib/likida/tope_consulta.test.ts:37-44` (`CAMINO_DEL_CIERRE`, ahora con
`processor.ts` y `cuadre/desde_db.ts`) · `:47-60` (la aserción) ·
`src/lib/likida/tools.ts:411-417` (`subir`, con `await supabaseAdmin().storage.
from('liquidaciones').upload(...)` **sin `acotada`**) y `:433-434` (se llama
**dos veces**: el ejemplar del contralor y el del operador) ·
`src/lib/likida/processor.ts:1184` (el mismo `storage` en la reentrega, ese sí
`acotada(admin.storage.from(...))`) · `src/lib/likida/presupuesto.ts:76`
(`TOPE_CONSULTA_MS = 8_000`) · `src/lib/supabase/admin.ts:18` (el backstop de
25 s).

**La medición.** Apliqué el regex del propio guardia (`await supabaseAdmin()` +
`await admin.(rpc|from)(`, sobre el fuente sin comentarios) a todo `src/`:
**200 consultas crudas en 73 archivos de producción**. El guardia mira 6. Eran
203 en 75 en la 28, así que el arreglo movió exactamente los dos de
`processor.ts` y nada más. `tools.ts` —el archivo de `cerrar_viaje`, donde se
genera y sube el papel— no está en la lista y tiene la única cruda que le queda.

**Escenario, con valores.** El chofer manda «listo». `cerrar_viaje` genera los
dos PDF y los sube en serie (`tools.ts:433` y `:434`). Con Storage lento, cada
`upload` corre hasta el backstop de **25 s** del cliente en vez de los **8 s** del
tope fino: hasta **50 s** de los 120 s de la invocación en dos llamadas que el
guardia dice cubrir. Lo que sigue en la misma invocación es `saveLiquidacion`,
`sendDocument` y el aviso a la oficina. El modo de falla que el encabezado del
propio guardia describe (`:13-17`: «*la liquidación queda escrita, el operador no
recibe ni resumen ni PDF… y Meta no reintenta porque ya recibió su 200*») es
alcanzable desde el archivo que el guardia no mira.

**Consecuencia.** Es MEDIO y no ALTO por lo mismo que en la 28: el
`AbortSignal.timeout(25_000)` de `admin.ts:18` impide el cuelgue indefinido. Lo
que queda es el defecto del rubro, y es el que **reincidió**: un mecanismo cuyo
nombre y cuya aserción declaran una propiedad general —«el camino del cierre»—
implementado como allowlist literal, que es *el mismo modo de falla que este repo
documenta como el que mató a `acotada_guardiana.test.ts`* (citado en
`frontera_datos_guardiana.test.ts:8-13`, veinte líneas antes de reproducirlo).
La ventana enseñó cuánto cuesta: alguien tuvo que **darse cuenta a mano** de que
faltaba `processor.ts`, y en el mismo commit no se dio cuenta de `tools.ts`.

**Causa raíz probable:** la propiedad es «toda consulta del camino caliente lleva
techo» y se está midiendo con «estos N archivos no tienen consultas crudas»; la
unidad correcta ya existe al lado (`frontera_datos_guardiana` acaba de migrar de
archivos a llamadas y podría barrer igual).

---

### [MEDIO] ARQ-M2 — el plazo de conservación de la telemetría se promete en la prosa del aviso y se ejecuta con literales SQL, y nada ata los dos

`src/lib/likida/privacidad.ts:712` y `:715` («*Se conservan **180 días**; si el
evento fue grave… **365 días***», en dos ramas del aviso integral, escritas en
esta ventana por `910b755`) · `:401-415` (`versionAvisoVigente`: la firma que
decide si se reenvía el aviso se calcula **sobre el texto**) ·
`supabase/migrations/0288…:83-84` (los defaults `p_dias 180` / `p_dias_graves
365`) y `:174`, `0289…:135`, `0332…:299`, `0335…:341` (cuatro call sites que
repiten `(180, 365, …)` a mano) ·
`src/lib/likida/privacidad_leg3_aud24.test.ts:44-61` (la prueba nueva: exige que
**el texto** diga 180 y 365).

**Escenario, con valores.** Una flota pide retener la telemetría 365 días para
sus propios litigios laborales, y se sube el plazo leve de 180 a 365 en la
`mantenimiento_de_datos` de una migración 0348 —el patrón exacto de las cuatro
que ya existen: un `create or replace` que repite la llamada con otros números—.
El aviso de privacidad que cada chofer recibe por WhatsApp sigue diciendo «se
conservan **180 días**». Y como `versionAvisoVigente` firma **solo el texto**
(`:411`, serialización determinista de `avisoSimplificado` + `avisoIntegral`), la
firma no cambia, así que **ningún operador recibe el aviso nuevo** — precisamente
por el mecanismo que el mismo aviso promete («*el sistema calcula una firma del
texto y reenvía en cuanto deja de coincidir*»). `privacidad_leg3_aud24.test.ts`
queda verde: comprueba que el texto diga 180/365, que es justo lo que no cambió.

Entra una migración con `purgar_evento_seguridad_flota(365, 365, …)` → sale un
aviso de privacidad que declara un plazo de conservación **menor que el real**
para el dato de un tercero, con la firma diciendo que nada cambió.

**Consecuencia.** El aviso es el documento que la LFPDPPP obliga a mantener
exacto (art. 16 fr. IV, plazo de conservación) y el repo ya se quemó una vez en
sentido contrario (LEG-6: prometer «90 días» que ningún código ejecutaba,
citado en `privacidad.ts:703-710`). Para el equipo: el arreglo de la 28 cerró la
mentira vieja **copiando el número** en vez de derivarlo, así que la próxima
divergencia es idéntica y ya está armada.

**Intento de refutación.** (a) ¿No lo cubre la comparación de firma? No: la
firma cubre el texto contra el texto, nunca el texto contra el SQL. (b) ¿No hay
un guardia de migraciones? `migraciones_verificadas.test.ts` cotea qué migración
se prueba dónde, no valores dentro de un `create or replace`. (c) ¿No es de
`legal`? El daño es legal; el defecto es de acoplamiento y es mío: dos literales
de la misma verdad en dos lenguajes, sin mecanismo.

---

### [MEDIO] ARQ-M3 — el margen de reloj de los crons se deriva de un conteo de consultas hecho a mano, y ese conteo ya caducó una vez

`src/lib/likida/presupuesto.ts:399-401` (`margenUnidadAtomicaMs`) ·
`src/app/api/cron/gps/route.ts:39-63` (el conteo paso a paso y
`margenUnidadAtomicaMs({ consultas: 11, envios: 0 })`) ·
`src/app/api/cron/descarga-sat/route.ts:106` (`{ consultas: 3, envios: 1 }`) ·
`src/lib/likida/presupuesto.ts:83` (`TECHO_PASO_CONSULTA_MS = 9_500`).

**Escenario, con valores.** El helper es bueno: sustituye dos literales `20_000`
copiados por una derivación. Pero su entrada es un **conteo del código escrito a
mano en un comentario**, y `cron/gps/route.ts:58-62` documenta que la cifra
anterior («13 consultas + 1 envío») ya se había quedado vieja. Hoy `11 × 9,500 +
5,000 = 109,500 ms` de margen sobre `maxDuration = 300`. Alguien agrega una
consulta a `crearIncidencia` —p. ej. resolver la terminal de la unidad, que es
un `select` más en la cadena que el comentario enumera en su paso 2—: el peor
caso real pasa a `12 × 9,500 + 5,000 = 119,000 ms`, el margen sigue reservando
109,500, y una unidad despachada 110 s antes del corte se queda **9.5 s corta**.
Vercel mata la función a la mitad de `dispararAsistenciaPorEventoCamara`, después
de `crearIncidencia` y antes de `finalizarGrave`: queda una incidencia abierta
por un choque sin que nadie haya avisado al jefe. Nada se pone rojo — el número
vive en un argumento de llamada, no en el código que cuenta.

**Consecuencia.** Es el modo de falla que el helper existe para prevenir, movido
un nivel arriba: dejó de estar en un literal copiado y pasó a estar en un
comentario que hay que reauditar cada vez que se toca la cadena.

**Intento de refutación.** ¿Es peor que antes? No — es claramente mejor que
`20_000`, y el comentario está fechado (7-sep-2026) y explica su método. Lo
reporto porque el arreglo de la 28 lo dejó a un paso de ser verificable
(`acotada` ya etiqueta cada consulta con un nombre; contarlas es mecánico) y
porque la propia ventana demuestra que el conteo a mano caduca.

---

### [BAJO] ARQ-B1 — la pregunta «¿qué prospecto es este correo?» quedó con dos implementaciones al partir el webhook de Cal.com

`src/lib/admin/calcom_webhook.ts:225-240` (`encontrarProspecto`:
`.from('prospecto').select('id').eq('correo_normalizado', correo).
is('duplicado_de', null).limit(2)`) · `src/lib/admin/calcom.ts:470-484` (la
misma consulta, con dos columnas más, dentro de `entregarEventoCalcomLocal`).
Son las **únicas dos** apariciones de `correo_normalizado` en producción.

**Escenario, con valores.** El CRM agrega una columna de archivado (o cambia la
regla de deduplicación a `is('duplicado_de', null) and estado <> 'descartado'`) y
se actualiza `encontrarProspecto`, que es el que tiene nombre de función y
prueba. `entregarEventoCalcomLocal` conserva el predicado viejo: con un prospecto
`descartado` cuyo correo coincide, `calcom.ts:477` sigue viendo `filas.length ===
1`, entra a la rama de omisión de `:479-482` y **no entrega el evento** al
handler, que sí lo habría procesado. Un `BOOKING_NO_SHOW_UPDATED` se pierde sin
error ni bitácora.

**Consecuencia.** Baja hoy: es un camino de reconciliación best-effort del CRM
interno, no toca dinero de flota. Se reporta porque la extracción de ARQ-B1
—que hizo lo correcto: la entrega local ahora pasa por el MISMO handler, y su
encabezado explica por qué— dejó un **pre-filtro** que reimplementa la mitad del
handler que acaba de unificar, y eso reabre en pequeño la grieta que el arreglo
cerró en grande.

---

### [BAJO · REINCIDENTE, 7ª ronda] ARQ-B2 — `procesarTurno` volvió a crecer

`src/lib/likida/processor.ts:1554` (la firma) → `:4990` (el cierre de la
función) = **3,436 líneas**. Eran 3,253 en la 27 y en la 28. La ventana le sumó
**183**: el techo de reentregas (`:1134-1157`), la rama de carta muerta
(`:4078-4110`) y la resolución del `timestampCierreMs` (`:3999-4020`), todas
buenas por sí solas. No se extrajo nada. Sin escenario nuevo: el de la 24 sigue
escrito y sigue siendo el mismo.

---

## Lo que revisé y está bien

- **Los ciclos de importación, por dentro — y la corrección de mi propia
  medición.** Construí el grafo de módulos de producción (resolviendo `@/`,
  relativos, `index.ts` e `import()` dinámico) sobre `c7bbb83` y sobre `HEAD`
  con el mismo script. Contando `import type`, el mayor ciclo pasa de 6 a 24
  módulos y se traga el camino del cierre entero — y **eso es un artefacto**:
  la arista que los une es `wa_pendientes.ts:22`, `import type { InboundMessage }
  from './processor'`, que TypeScript borra al compilar. Con los `import type`
  fuera: **6 ciclos en los dos árboles, el mayor de 5**
  (`briefing_inicio_wa` → `operacion` → `asistencia_wa` → `relojes_legales` →
  `administracion`), idénticos. Verifiqué además lo que la 28 dejó pendiente:
  ninguno de los siete módulos de los ciclos evalúa un binding de su socio en el
  cuerpo del módulo (todos los usos están dentro de funciones), así que no hay
  un «Cannot access before initialization» esperando a un orden de importación
  distinto en producción.
- **Las dependencias invertidas bajaron de 3 a 2 y ahora hay quien las cuente.**
  Medido sobre el grafo: `oficina_wa.ts → app/api/dashboard/chat/tope.ts` y
  `mcp/credencial.ts → app/api/v1/_comun.ts`. `sin_importar_app.test.ts:31` las
  vigila con un regex que **sí** ve `import('…')`, y su tercer `it` (`:79-81`)
  exige que el barrido encuentre exactamente esas dos — o sea, el guardia se
  cae si se queda ciego, que es lo que le faltaba al de la 27.
- **El motor del dinero sigue siendo puro.** `cuadre/engine.ts`: cero `async`,
  cero `await`, y sus once imports son todos de cálculo o de tipos —
  `util`, `tope_alimentacion`, `fecha_dudosa`, `intake/sanitizar`, `intake/cfdi`,
  `facturacion/caducidad`, `facturacion/identificar`, `normas/indice`,
  `intake/evidencia_monedero`, `types/likida`, `lib/formato`. Nada de Supabase,
  nada de red. La frontera con I/O la sostiene `cuadre/desde_db.ts`, que es quien
  lee y le pasa los datos ya materializados.
- **El ejemplo canónico del rubro está cerrado y vigilado.**
  `engine.ts:1891` dice `otro: 'Otro'` con el comentario que lo explica, `pdf.ts`
  ya no tiene mapa propio (importa `etiquetaConcepto`), y
  `etiquetas_sincronizadas.test.ts:43` barre **todo** `src/` buscando el patrón
  `const CONCEPTO(_LABEL)?` en vez de una lista de rutas — la lección de
  `gasto-semanal-chart.tsx`, aplicada.
- **El inventario de crons no se ha podrido.** Crucé `vercel.json` contra
  `src/app/api/cron/`: las 11 rutas declaradas existen y no hay ninguna ruta de
  cron en disco sin declarar (solo `_reloj_duro.ts` y un `.test.ts`, que no son
  rutas).
- **Los escritores duplicados que temía no aparecieron.** `esEventoGrave`
  (`conectores/eventos_seguridad.ts:96`) es fuente única en TS y el SQL de purga
  lee la **columna** `grave` que ese código escribe (`0288:100-105`), no un
  segundo criterio. `copiasDeComprobante` (`engine.ts`) es el único juez de «esto
  es copia» en TypeScript, con seis llamadores y ninguna reimplementación —
  incluido `consulta_chofer.ts:199`, nuevo en esta ventana, que lo importa en vez
  de copiarlo.
- **La superficie nueva casi no es superficie de producción.** De los 222
  archivos tocados, **un solo archivo de producción es nuevo**
  (`lib/admin/calcom_webhook.ts`, y nace de vaciar una ruta, no de agregar
  lógica). El resto de los +10,318 renglones son pruebas. Esa es la razón
  principal por la que la ventana no produjo una regresión estructural grande.
- **Un detector de clones POR CONTENIDO** (bloques de ≥8 líneas no triviales
  idénticas entre archivos distintos, el trabajo que la 28 dejó pendiente): **49
  pares**. Los abrí por muestreo dirigido a los que tocan dinero o datos: el de
  `v1/viajes/[id]/contribucion/route.ts` contra `libro_viaje.ts` es solo la
  interfaz restatada — el cálculo lo hace `armarRenglon`, reusado; el de
  `admin/compliance/page.tsx:186` contra `repo.ts:1643` es la misma lectura ARCO
  mapeada dos veces, hoy idéntica campo por campo. El grueso son las `forma.tsx`
  del dashboard (siete archivos comparten el mismo andamio de campo), que la 24
  ya marcó y que no cambian ningún significado.
- **`npx tsc --noEmit -p .` → exit 0** y los nueve guardias estructurales
  (62 pruebas) verdes.

---

## Lo que NO alcancé a revisar

- **Los 49 pares de clones, uno por uno.** Los medí y abrí seis. Las siete
  `forma.tsx` y los tres `chat.tsx` siguen sin evaluarse por dentro: no sé si
  divergieron en validación o solo en presentación.
- **`conectores/sincronizar_eventos.ts`, por tercera ronda.** Sigue siendo el
  archivo con más acceso directo nuevo y no leí si duplicó un criterio de
  geocerca. Solo verifiqué que su clasificación de gravedad delega en
  `esEventoGrave`.
- **Las migraciones 0319-0347 y qué redefine cada `create or replace`.** Solo
  abrí 0288, 0289, 0317, 0325, 0332, 0335 y 0345 por los hallazgos de arriba. Los
  cuatro `create or replace mantenimiento_de_datos` que encontré repitiendo
  `(180, 365, …)` sugieren que ese patrón —redefinir la función entera para
  cambiar un parámetro— puede haber dejado más literales duplicados que no busqué.
- **`lib/mcp/herramientas/*` contra `/v1/*`.** Pendiente desde la 26. Esta
  ventana agregó `mcp/herramientas/dinero.ts → likida/repo.ts`, que va en la
  buena dirección, pero no comparé los dos contratos.
- **Nada que requiera base viva.** Los umbrales (1,000 filas de PostgREST,
  25 s del backstop, 9,500 ms de `TECHO_PASO_CONSULTA_MS`) son los que el propio
  repo documenta, no medidos contra Postgres ni contra Vercel.
- **Si `MAX_INTENTOS_PENDIENTE` y el `5` de la 0325 coinciden en PRODUCCIÓN.**
  Leí el árbol; qué versión de `listar_wa_pendientes` está aplicada en la base
  viva no lo puedo saber desde aquí, y `operabilidad` documentó que producción
  iba atrás del repo.
