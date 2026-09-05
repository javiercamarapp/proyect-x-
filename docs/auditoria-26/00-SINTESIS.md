# Auditoría 26 — Síntesis y recalificación

**Global: 6.0** (anterior: **5.3**) · **▲ 0.7**

Ronda **COMPLETA**, desatendida, en la nube. Rama `claude/auditoria-26` sobre
`master` = `ce6f462`. Árbol limpio al arrancar → **autofix habilitado**.

## Por qué esta ronda fue completa

La decisión se tomó **antes** de gastar un token en auditores:

- `list_pull_requests(state=open)` sobre `javiercamarapp/cuadra` → **un solo PR,
  #324 `dof-diario: 2026-09-03`**. No es de auditoría, así que no aplica la
  regla de continuación.
- `git log 4f94490..HEAD -- src/ supabase/ normas/` → **124 commits, 220
  archivos, +10,428/−783**. Con cambios, no aplica la ronda ligera.

El clon de la nube no traía `node_modules`: `npm ci` antes de la compuerta
(INFRA, resuelta).

## La lectura de la ronda

**Nueve rubros suben, tres se quedan, ninguno baja.** Es el movimiento inverso
al de la 25, y por la razón inversa: **esta vez el código sí cambió**.

Entre el cierre de la 25 y hoy aterrizó una «resolución integrada» (PR #322) de
~110 commits que atacó casi todos los pendientes que la 25 dejó abiertos con el
tope de vueltas agotado. El trabajo de esta ronda no fue buscar en superficie
nueva: fue **verificar si esos cierres eran de verdad**, abriendo el archivo uno
por uno. Diez de los doce auditores reportan cierres verificados con mecanismo y
prueba.

Y el sesgo que se les pidió corregir es el que la 25 documentó: **un cierre a
medias sale más caro que un hallazgo abierto, porque la nota ya cobró la
subida.** Por eso varios rubros suben un punto y no dos: `backend` cerró 9 de 11
y su CRÍTICO sigue vivo a medias; `tool-calling` cerró 4 de 5 y no se mueve
porque entró una regresión que se comió la subida; `frontend` cerró sus cuatro
asignados —por primera vez en cuatro rondas— y se queda igual porque el trabajo
de esta misma ronda metió tres defectos en la pantalla donde se firma dinero.

**El caso que mejor lo explica es el mío.** Arreglé el CRÍTICO fiscal FIS-C2 y
relancé al auditor sobre mi propio arreglo. Encontró otro CRÍTICO **en la línea
exacta que acababa de editar** (el gasto sin fecha), y tres afirmaciones mías
que no se sostienen. Los dos están arreglados; las tres afirmaciones se
corrigen abajo.

## Las notas

Global = media aritmética de los 12 rubros, con un decimal (72 / 12 = 6.0).

| Rubro | Antes | Hoy | Δ | Porqué del movimiento |
|---|---|---|---|---|
| Pruebas | 7 | **8** | ▲1 | **Se atacó y subió.** 5 de 6 abiertos cerrados, y cerrados de verdad: rompió cada función con su mutación exacta y vio la prueba ponerse roja. Corrió la batería SQL **entera contra un Postgres 16 real por primera vez en una auditoría** (234 bloques, 0 fallos) y midió la cobertura que la 25 dejó pendiente. 15 mutaciones dirigidas: 11 muertas, 4 vivas, **cero en el motor y en la escritura del dinero, cuarta ronda seguida**. |
| Backend y API | 6 | **7** | ▲1 | **Se atacó y subió.** 9 de 11 abiertos cerrados de verdad, 8 con prueba propia (52 casos corridos). No sube más porque su CRÍTICO va por su tercera ronda **cerrado a medias**: `d914e74` movió la frontera al desglose de la LIQUIDACIÓN y dejó intacto el del COMPROBANTE, que es de donde la póliza saca dos de los tres términos de su resta. |
| Seguridad | 6 | **7** | ▲1 | **El código cambió.** Los siete abiertos verificados uno por uno y los siete cerrados de verdad, no a medias. Las 15 migraciones nuevas limpias: 0 `security definer` sin `search_path` sobre las 152 funciones de las 296 migraciones. Ninguna ruta sin autenticar a datos de un tenant (67 `route.ts`, 147 tablas con RLS, 6 buckets, 7 firmas de webhook recorridos). No sube a 8 porque el ancla se cumple a medias: en el segundo factor las capas siguen siendo una sola. |
| Sistema agéntico | 5 | **6** | ▲1 | **Se atacó y subió.** 8 de 10 cerrados, incluidos los dos ALTO que llevaban dos rondas verbatim desde la 24 y las dos salidas de correo que la 25 dejó como «lo primero de la 26». Sus dos ALTO son nuevos: uno es una **regresión del propio arreglo `908d69b`** (el aviso al contralor se reintenta sin techo, una vez por cada mensaje del chofer durante 24 h), el otro salió de recorrer un ciclo que ninguna ronda había caminado. |
| Cumplimiento legal | 5 | **6** | ▲1 | **Se arregló de verdad, con una reapertura.** LEG-1 y LEG-6 cerrados; LEG-2 y LEG-5 parciales; **LEG-4 reabierto por su propio arreglo de seguimiento `5c9c1cd`**: la excepción por evento grave no se acotó al cuadrante que la justificaba, así que con viaje vivo el evento se ata a un operador identificado que nunca recibió el aviso, con la liga al video y a 365 días. |
| Rendimiento y costo | 5 | **6** | ▲1 | **La deuda de la 25 se pagó.** A1, A2, A4, A6 y A9 cerrados, y el costo por liquidación por fin concuerda consigo mismo y con la medición ($0.18 → $0.1848 → techo $138.60). Su CRÍTICO es nuevo: `ingerirRep` hace 2 consultas por DoctoRelacionado y nunca mira el reloj — ~96 doctos agotan los 57 s del correo, y ahí la muerte deja puesta la fila de dedup, así que el reintento rebota por «ya procesado» y el CFDI se pierde. |
| Modelo de datos | 5 | **6** | ▲1 | **El código cambió.** 7 de 8 abiertos cerrados de verdad (0304 con prueba que cruza `FaseCosto` contra el CHECK, 0309, 0310, 0311, 0312/0315, 0307 y el bloque 249 con dientes). DATOS-C1 cerró **parcial**: la RPC sustituye el desglose entero en su transacción, pero los sellos de entrega y `pdf_url` se quedaron en un `update` best-effort con tres retornos tempranos que lo saltan. |
| Tool calling | 6 | **6** | = | **Se atacó y subió, y entró una regresión que se lo comió.** 4 de 5 cerrados de verdad. TC-1 queda a medias **por segunda ronda**: el orden sí se unificó, pero hay un **cuarto lector** —`estadoDelViaje`— que sigue sumando las copias, y es el que contesta cada acuse de foto sin pasar por el modelo. TC-3 cumple su **quinta** ronda sin tocarse. La regla estructural aguanta: 34 tools, ninguna acepta un dato del modelo que decida sobre dinero o pertenencia. |
| Cumplimiento fiscal | 4 | **5** | ▲1 | **El código cambió, y mucho.** Su CRÍTICO —el de las rondas 23, 24 y 25— se arregló **en esta ronda** (`abf6921`), y la reauditoría del arreglo encontró otro en la misma línea, también arreglado (`8abb596`). Sube uno y no dos porque quedan criterios divergentes vivos: un REP cuyo `FormaDePagoP` es a su vez '99' la RPC lo cuenta y el predicado de TS no lo juzga, y hay un cuarto sitio (`tools.ts:200`) que pregunta el acumulado **sin claves** y contesta «holgado» sobre la misma corrida cuyo PDF imprime «No deducible». |
| Arquitectura | 4 | **5** | ▲1 | **El código cambió.** El CRÍTICO de la 25 —la proporción de LIVA 5 fr. I en tres sitios, el tercero con `?? 1`— **cerró de verdad**: `fiscal.ts:530` importa `proporcionesDeducibles` del motor en vez de reinventarla. 6 de 8 cerrados con mecanismo y prueba verde; 1 parcial y 1 reincidente que creció. |
| Frontend | 5 | **5** | = | **Se atacó y subió, y la deuda cobró factura el mismo día.** Por primera vez en cuatro rondas cerró sus cuatro asignados, y tres de los cuatro con prueba que mide lo que el hallazgo **preguntaba**. A cambio, el trabajo de esta misma ronda metió tres defectos en `/dashboard/[id]`, la pantalla donde se firma: `74109dd` le puso a `estadoRenglon` una pregunta que su dato no puede contestar, y `d914e74` cambió lo que «Ajustar» HACE sin cambiar lo que la pantalla DICE que hace. Dos arreglados aquí. |
| Operabilidad y DX | 5 | **5** | = | **Se mantiene:** cinco cierres reales (fallo solo-de-cliente, `pdf.no_entregado`, el 429 de la compuerta, el guarda de `repair_migrations`, el backup del runbook) contra dos CRÍTICOS que **empeoraron**. Producción lleva **290 commits, 12 merges y 17 migraciones** sobre el último `[deploy]` efectivo, y está **congelada**, no solo atrasada: la compuerta bloqueará cualquier `[deploy]` mientras la base siga en 0301. Y toda la capa de operación vive en Actions, que el 3-4 sep estuvo bloqueado por límite de gasto: **la ausencia de corridas es indistinguible de verde**, y no hay monitor externo. |

## Lo arreglado, con prueba que lo reproduce

Cuatro commits atómicos. Cada uno: prueba que falla sin el arreglo → arreglo →
prueba verde → suite completa → commit citando el ID.

| ID | Sha | Qué era |
|---|---|---|
| **FIS-C2** (CRÍTICO) | `abf6921` | El cubo del 15 % (RFA 2026 regla 2.9) se arma restándole `efectivoDeEsteViaje` al acumulado del ejercicio. Los dos términos tienen que juzgar la forma de pago igual o la resta miente. La mig. 0305 movió el acumulado a la forma EFECTIVA y dejó la resta con la CRUDA, sobre una premisa escrita en su propia cabecera y falsa («`Gasto` no trae `pagadoForma`»; `repo.ts` lo mapea desde siempre). Un diésel '99' cuyo REP revela efectivo consumía su propio cupo: con $150,000 sobre $1,000,000 —**exactamente el 15 %, el caso que la regla SÍ ampara**— el motor devolvía deducible $0 / no deducible $150,000 / IVA $0 mientras el panel del contador imprimía $24,000 sobre el mismo UUID. `formaPagoJuzgableDe` deja de ser constante local y se exporta. 4 pruebas; la primera pasa de 150,000 a 0. |
| **FIS-C2b** (CRÍTICO) | `8abb596` | **Lo encontró la reauditoría del arreglo anterior, en la línea que ese commit acababa de editar.** El `.filter` tiene que espejar el `where` de la RPC en TODOS sus términos; `abf6921` alineó el de la forma de pago y dejó el de la fecha. La 0305 acota por rango de fechas y una `fecha` NULL falla las dos comparaciones: el gasto sin fecha NO entra al acumulado. El `?? anioEjercicio` lo daba por del ejercicio y lo restaba igual, dejando el previo CORTO — el error hacia el otro lado: **regalar** cupo del 15 %. Medido: previo 65,000 donde debía ser 145,000. No es de laboratorio: el prompt del OCR ordena devolver la fecha en null cuando el ticket no la trae legible. |
| **FE-4** (ALTO) | `273ecd9` | El botón «Autorizar lectura» del consentimiento OAuth del MCP —la pantalla donde alguien concede lectura de las cifras de su flota— se pintaba con `background: var(--fg)`, y `--fg` no existe en ninguna hoja del repo (la tinta se llama `--ink`). Sin fallback, `var()` deja la declaración inválida: el botón se quedaba con el fondo de la página y el texto del color de la página. **1.00:1 en claro y en oscuro.** `contraste.test.ts` no podía verlo porque mide los tokens que se DEFINEN, no los que se REFERENCIAN. |
| **FE-1** (ALTO) | `75ec862` | `74109dd` le enseñó a `estadoRenglon` a preguntar `pagoPendiente(g)` importando el predicado del motor, que es lo correcto — y no tocó la consulta: `leerGastos` no seleccionaba `pagado_en` y el tipo ni lo declaraba. Con `pagadoEn` siempre `undefined` el predicado colapsa a `formaPago === '99'`, así que **todo CFDI a crédito ya pagado con su REP salía «Por confirmar»** mientras el bloque de Deducibilidad de la misma hoja lo contaba como deducible. La prueba de la 25 seguía verde porque le pasaba `pagadoEn` a mano: una forma de dato que ningún llamador de producción podía producir. |

## Lo que se intentó y se REVIRTIÓ, con la razón

**El matcher de la bandera `[deploy]`.** Reproducido con salida real: hoy
`node scripts/ci/ultimo-deploy-en-asunto.mjs` devuelve `311addd`, cuyo asunto es
*«fix(ci): OP-2 indenta el heredoc del aviso de [deploy] para que sea YAML
valido»* — un commit que jamás se publicó. `FLAG_DEPLOY_RE` casa en cualquier
posición del asunto, así que un asunto que HABLA de la bandera la dispara: el
detector de deriva mide contra un ancla falsa y `decidir()` con ese asunto
devuelve `construir: true`.

Escribí la prueba (4 rojas, 8 verdes) anclando la bandera a los extremos del
asunto, **y la reverté al comprobar que no arregla el síntoma**: el siguiente
match sería `d220273` («…avisar ANTES de que un merge commit pierda el
[deploy]»), que TERMINA con la bandera igual que los cuatro despliegues
legítimos que la llevan de sufijo. Ningún criterio léxico separa «…monedero
[deploy]» de «…pierda el [deploy]». Arreglarlo a ojo arriesga que un `[deploy]`
legítimo deje de publicar en silencio, que es el peor modo de falla de este
sistema y el que su propio historial documenta. **Queda propuesto: exige
decidir una convención** (p. ej. que la bandera sea el primer token del asunto,
y documentarlo).

## Lo que corrijo de mis propias afirmaciones

La reauditoría verificó lo que escribí y tres cosas no se sostienen. Se dicen
aquí porque un rótulo tiene que ser verdad también dentro de un mensaje de
commit:

1. **«`formaPagoJuzgableDe` es la MISMA regla que la 0305»** — falso en un caso:
   un REP cuyo `FormaDePagoP` es a su vez `'99'`. La RPC lo cuenta en el cubo;
   `medioNoAdmitidoCombustible('99')` devuelve `false`, así que TS ni lo resta ni
   lo juzga. El comentario en `desde_db.ts` ya está corregido (`8abb596`) y el
   caso queda como hallazgo ALTO abierto.
2. **«un solo dueño en TS»** — falso: existen además `fiscal.ts:229` (equivalente,
   verificado) y `engine.ts:1657` (no equivalente, inocuo en sus dos usos).
3. **«la 23, la 24 y la 25 lo dieron por cerrado»** — falso, y contra los propios
   documentos: `docs/auditoria-24/RESULTADO.md:32` y
   `docs/auditoria-25/00-SINTESIS.md:100` lo reportan como **abierto**. Lo
   correcto es «reincidente de la 23, la 24 y la 25», sin la acusación de cierre
   falso.

## Presupuesto: 4 vueltas contra un tope de 3

Se dice tal cual en vez de contar la revertida como «no vuelta»: la del matcher
`[deploy]` gastó su vuelta entera —prueba escrita, ejecutada y descartada— y el
tope existe para medir exactamente eso. La cuarta (FIS-C2b) se hizo a sabiendas:
un CRÍTICO descubierto **dentro de la línea que uno acaba de editar** no es
material de la ronda siguiente.

## Los CRÍTICOS que quedan abiertos, con su razón

Ninguno es quirúrgico; los cuatro piden una decisión que una rutina desatendida
no debe tomar sola:

1. **Póliza tras «ajustar»** (backend, 3ª ronda) — `ajustar` mueve `gasto.monto`
   y, a propósito, no toca `sub_total`/`iva_traslado` (son el HECHO del CFDI).
   La póliza deriva su residuo de una identidad que mezcla las dos cosas, así
   que al alza **inventa** un «IVA/IEPS no acreditable» de $7,200 en el archivo
   que va al ERP del cliente, y a la baja tira el periodo entero con 409.
   Arreglarlo exige decidir qué hace la póliza con una liquidación ajustada.
2. **`ingerirRep` sin reloj** (rendimiento) — 2 consultas por DoctoRelacionado,
   sin mirar el tiempo; en el correo la muerte deja puesta la fila de dedup y el
   reintento de Resend rebota por «ya procesado»: el CFDI se pierde.
3. **Producción congelada** (operabilidad, 4ª ronda) — 290 commits y 17
   migraciones sobre el último `[deploy]` efectivo. **Necesita una mano
   humana**: aplicar 0302→0318 y publicar. El Redeploy del panel no basta.
4. **La operación entera depende de Actions** (operabilidad) — pulso, compuerta,
   rollback y respaldo viven ahí, y el 3-4 sep Actions estuvo bloqueado por
   límite de gasto. Sin monitor externo, la ausencia de corridas se ve igual que
   el verde. Es una decisión de infraestructura, no un parche.

## Compuerta al cerrar

Sobre el árbol final:

- `npx vitest run` → **861 archivos, 11,287 pruebas, 1 saltada, 0 fallos**
  (+3 archivos y +12 pruebas de esta ronda; la 25 cerró con 820/10,962).
- `npx tsc --noEmit -p .` → **exit 0**.
- `npm run lint` → **0 errores**, 194 avisos.
- `npm run lint:ratchet` → **194/194 heredados, 0 nuevos**.
- `npm run build` → **no corre aquí a propósito**: pide Supabase, OpenRouter,
  Facturapi y Upstash.

**Tablero:** `tablero.html` + `tablero.png`, capturado con Chromium headless
(`--force-prefers-reduced-motion`) y **mirado**. La primera captura salió mal
—las cuatro columnas de severidad se partían en 2×2— y se rehízo fusionándolas
en una sola celda; eso es lo que significa mirarlo. En la captura buena se
cuentan los 12 rubros y las notas cuadran contra esta síntesis (72/12 = 6.0).
El color codifica **la nota, no el delta**.

## Nota de método

`.gitignore:34` trae `docs/auditoria-*/`, y los archivos de la 25 están
trackeados: en su día se agregaron con `-f`. **Sin `git add -f` la ronda entera
se cae del commit sin un solo aviso** —`git status` sale limpio y todo parece
bien—. Queda anotado porque es exactamente la clase de fallo silencioso que
esta rutina existe para no repetir.

Al auditor de pruebas se le prohibió expresamente mutar el árbol vivo (la 25
documentó un falso rojo por eso) y se le mandó trabajar sobre copia. Lo hizo:
levantó un Postgres efímero y un worktree de mutación aparte, y los borró. El
árbol quedó limpio.
