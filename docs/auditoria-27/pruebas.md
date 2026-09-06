# Pruebas — auditoría 27

**Nota: 6/10** (antes 8). Razón del movimiento: **mirada más profunda** — el
código no empeoró, la nota anterior estaba inflada. El ancla del 8 dice, textual,
«cada arreglo histórico tiene prueba anclada con el ID del bug **y el CI corre en
cada push**». La primera mitad sigue siendo cierta y es excelente: de las **12
mutaciones que apliqué sobre los arreglos de esta ronda, las 12 murieron**. La
segunda mitad no lo es: **29 de los 47 archivos de `supabase/tests/` (4,469
líneas de SQL y bash) no los ejecuta ningún workflow ni ningún script de npm**, y
son justamente la razón escrita que exime a **11 migraciones** de tener bloque en
`verificaciones.sql`. Y una de las pruebas de paridad que sostiene la exención de
una migración marcada CRÍTICA en la re-auditoría 25 es literalmente `f(x) ===
f(x)`: la destripé por dentro y salió **26/26 verde**. Ninguna de las dos cosas
se miró en las tres rondas anteriores.

Riesgo mayor del rubro, hoy: **la mitad SQL del dinero —el agregado que alimenta
el panel del contador— se declara probada por escrito y no la ejecuta nadie.**

---

## Cómo se midió (repetible)

Todo en un `git worktree --detach` bajo el scratchpad sobre `06b2eca4`
(`node_modules` por symlink); el árbol vivo no se tocó y el worktree quedó
borrado (`git worktree list` con una sola entrada).

- **Línea base reproducida**: `npx vitest run` → **905 archivos, 12,174 pruebas,
  1 saltada, 5 fallan**, 170 s. Los 5 fallos son los de IPv6 de
  `scripts/ci/e2e/proxy-local.test.ts`, INFRA. Toda mutación se midió contra
  esta línea: sobrevive = exactamente 5 fallos, ni uno más.
- **Cobertura medida** (excluyendo el archivo de IPv6, porque **vitest no
  imprime ni evalúa los umbrales cuando algún test falla**):
  statements **83.22 %** · branches **73.31 %** · functions **86.64 %** · lines
  **85.91 %**.
- **15 mutaciones dirigidas de TypeScript** (tabla abajo) + 1 barrido estático de
  los 242 bloques de la batería SQL con la función `calificar()` real +
  1 barrido de funciones exportadas sin mención en ninguna prueba.

### Mutaciones

| # | Qué rompí | `archivo:línea` | Resultado |
|---|---|---|---|
| M1 | `'LR022'` fuera de `CODIGOS_PARA_PANTALLA` (el duplicado del 0347) | `revision.ts:369` | **muerta** |
| M2 | el log emite `msg` sin redactar | `logger.ts:177` | **muerta** |
| M3 | los filtros de exportación vuelven a `{}` (setter de prototipo) | `acciones-exportar.ts:30` | **muerta** |
| M4 | el pool sigue tras fallar el claim (pierde el orden del chofer) | `webhook/whatsapp/route.ts:443` | **muerta** |
| M5 | la póliza se exporta sin exigir firma | `export/poliza/route.ts:358` | **muerta** (3 casos) |
| M6 | `ajustesIncompatibles` nunca bloquea | `export/poliza/route.ts:118` | **muerta** (7 casos) |
| M7 | `getLiquidaciones` vuelve a contar rechazadas | `analytics.ts:1977` | **muerta** |
| M8 | una rechazada devuelve `0` en vez de `null` | `analytics.ts:1061` | **muerta** (2 casos) |
| M9 | al chofer se le manda el ejemplar del CONTRALOR | `processor.ts:4370` | **muerta** (4 casos, uno con el nombre exacto de la garantía) |
| M10 | revierte FIS-C2c: «sin año» vuelve a ser «de este año» | `cuadre/engine.ts:766` | **muerta** |
| M11 | revierte el fix del QR (cortar con cualquier código) | `intake/cfdi_imagen.ts:122` | **muerta** — la caza el fixture de foto real |
| M12 | `otroEjercicioDe` de la prueba de paridad → `false` | `fiscal_agregado.test.ts:156` | **SOBREVIVE — 26/26 verde** |
| M13 | `renglonesAjenosDe` de la prueba de paridad → `false` | `fiscal_agregado.test.ts:129` | **SOBREVIVE — 26/26 verde** |
| M14 | una nota de crédito vuelve a ser «consolidado» | `intake/cfdi_xml.ts:186` | **muerta** (2 casos) |
| M15 | fuera el desempate determinista de actividad reciente | `analytics.ts:304` | **muerta** |
| B1 | `anularAsiento` pierde `.is('anulado_en', null)` | `jornada/repo.ts:524` | **SOBREVIVE** (suite completa) |
| B2 | `cerrarDia` pierde `.eq('estado','abierto')` | `jornada/repo.ts:556` | **SOBREVIVE** |
| B3 | `sellarConformidad` pierde `.is('conforme_operador_en', null)` | `jornada/repo.ts:588` | **SOBREVIVE** |
| B4 | `decidirFacturaProveedor` pierde `.eq('estado','pendiente')` | `proveedores.ts:322` | **SOBREVIVE** |
| B5 | `contarConCfdi` devuelve `0` cuando la base falla | `facturacion/pendientes.ts:221` | **SOBREVIVE** (reincidente 26) |
| B6 | una flota con la descarga PAUSADA pide rango al SAT | `sat_descarga/escritura.ts:157` | **SOBREVIVE** (reincidente 26) |

**Lectura**: cero sobrevivientes en el motor, el cuadre, la póliza, el PDF, la
analítica y el intake — quinta ronda seguida. Los seis sobrevivientes están
todos en **escrituras de la periferia sin arnés** y en **una prueba de paridad
que se compara consigo misma**.

---

## Hallazgos

### [CRÍTICO] La canasta mixta: tres capas de pruebas verdes sobre una entrada que producción no puede producir desde el 24-ago-2026

`src/lib/likida/intake/ocr.ts:62-78` (los dos campos retirados del esquema) ·
`src/lib/likida/cuadre/engine.ts:974` (`g.ocrExtra.renglones`, el único lector) ·
`src/lib/likida/cuadre/renglones_ajenos.test.ts:26-33` (el fixture) ·
`src/lib/likida/fiscal.test.ts:670` ·
`supabase/migrations/0317_…sql:104-124` (la bandera SQL) ·
`src/lib/likida/fiscal.ts:1017`

**Escenario.** El 24-ago-2026, `b349b724` retiró `renglones` (y
`plazo_facturacion_horas`) del esquema de structured output del OCR porque
tumbaron el OCR en producción (`400 Provider returned error`, `llm_costo` con
`tokens_in/out = 0`). **Nadie más escribe `ocr_extra.renglones`** — lo verifiqué
sobre los seis sitios que escriben `ocr_extra` (`repo.ts:381`,
`gasto_correccion.ts:105/167`, `processor.ts:1925/2377/3273`,
`consolidado.ts:301`, `intake/ocr.ts:615`): ninguno lo produce. Entra el ticket
de Walmart de $640.49 con $299 de manguera de jardinería y $258 de dos tapetes
—el ejemplo textual del comentario que el propio commit borró—:
`Array.isArray(renglones)` es `false`, la diferencia `renglones_ajenos` nunca se
levanta, `cubetaDe` cae al default `deducible` y el PDF imprime **«Deducible
para ISR $640.49»** con su IVA acreditable. La bandera `renglones_ajenos` de la
RPC 0317 es, por la misma razón, **falsa para toda fila del universo**, así que
el panel del contador acredita ese IVA también.

Mientras tanto la suite afirma lo contrario en tres capas: el motor
(`renglones_ajenos.test.ts`, que construye a mano el `ocrExtra.renglones` que ya
nadie emite), el panel (`fiscal.test.ts:670`, «renglones_ajenos: NO acredita») y
el agregado (`fiscal_agregado.test.ts:197/261`). Las tres pasan; las tres miden
una entrada imposible.

**Consecuencia.** Es exactamente el patrón que `CLAUDE.md` ya documentó para
`ticket_mensaje` («dos LECTORES y cero escritores, y por eso la alarma era
insatisfacible por construcción»), esta vez sobre una cifra fiscal. El contralor
archiva un PDF que declara deducible una manguera de jardinería, y si pregunta
«¿esto está probado?» la respuesta del repo es que sí. El commit que lo causó lo
dejó escrito y nadie lo ancló: «Ninguna de ellas habría atrapado esto: todas
mockean el LLM». `plazoFacturacionHoras` (`engine.ts:1307`) está en el mismo
estado, sin siquiera una prueba: **cero** archivos lo nombran.

**Causa raíz probable:** el esquema de structured output es un contrato de
INTEGRACIÓN con el proveedor y no tiene arnés de ningún tipo; al retirar un campo
nadie tiene forma de enterarse de qué reglas del motor se quedaron sin insumo.

---

### [ALTO] 29 de los 47 arneses de `supabase/tests/` (4,469 líneas) no los corre nada — y son la razón escrita que exime a 11 migraciones de tener bloque

`src/lib/likida/migraciones_verificadas.test.ts:53-59` (`'0324'`, `'0325'`,
`'0327'`, `'0328'`, `'0329'`, `'0330'`, `'0331'`) y `:60-66` (`'0333'`, `'0334'`,
`'0336'`, `'0337'`) · `.github/workflows/ci-postgres.yml:175-191` (la lista de
arneses que sí corre, escrita a mano) · `src/lib/likida/pruebas_en_ci.test.ts:167`
(la red que ancla **dos** de los 47)

**Escenario.** Barrí cada archivo de `supabase/tests/` contra `.github/`,
`scripts/` y `package.json`. Resultado: **18 tienen invocador, 29 no tienen
ninguno** — entre ellos `0324_gps_poll_durable.sql`,
`0325_capacidad_wa_jornada.sql`, `0327_calcom_retencion_forward.sql`,
`0330_gps_r3_red.sql`, `0331_capacidad_r3_red.sql`, `0333_gps_r4_red.sql`,
`0334_capacidad_r4_red.sql`, `0336_capacidad_r5_red.sql`, `0337_gps_r5_red.sql`
y sus nueve `.sh` de concurrencia. Son arneses buenos —leí el de 0337: prueba que
un webhook reentregado no haga retroceder `recibido_en` cuando el estado sí
progresa `delivered → read`— y no se ejecutan jamás.

La compuerta que debería notarlo es `migraciones_verificadas.test.ts`, y solo
exige que la exención tenga **≥20 caracteres de prosa**: no comprueba que el
archivo citado exista, ni que alguien lo corra. Peor, siete de esas exenciones se
leen como afirmaciones de ejecución («se prueba en … contra PostgreSQL real»,
0330; «ejecutados contra PostgreSQL real», 0324) mientras cuatro sí son honestas
y lo declaran («Esta exención sólo clasifica dónde vive la evidencia; **no afirma
que ci-postgres los ejecute**», 0333/0334/0336/0337). Un lector que confíe en el
archivo no puede distinguirlas.

Concreto: redefine `reclamar_polls_conector` (0324) en una migración nueva para
que devuelva siempre el mismo tenant. `npm test` verde, `ci-postgres` verde
—no hay bloque en `verificaciones.sql` y el arnés que lo probaría no se
ejecuta—, y `migraciones_verificadas.test.ts` sigue verde porque su exención
tiene un párrafo. La flota grande se come el poll de las demás y nadie se entera
hasta que un cliente pregunte por qué no ve pines.

**Consecuencia.** El repo tiene escrito el principio exacto que esto viola
—«Una prueba que no corre en CI es documentación con sintaxis de prueba»,
`pruebas_en_ci.test.ts:70`— y lo aplica por catálogo a los `skipIf` de vitest,
pero a los arneses SQL solo a mano y solo a dos (`0332` y `0335`, anclados en
`pruebas_en_ci.test.ts:167-170`). El equipo lee «11 migraciones exentas con razón
escrita» como cobertura y son 11 migraciones sin una sola aserción ejecutada.

**Causa raíz probable:** el paso «DB retención» de `ci-postgres.yml` enumera
archivos a mano; nada barre el directorio y exige que cada arnés tenga invocador.

---

### [ALTO] La prueba de paridad que justifica la exención de la 0317 (CRÍTICO de la re-auditoría 25) es `f(x) === f(x)`: la destripé y salió 26/26 verde

`src/lib/likida/fiscal_agregado.test.ts:125-161` (los cinco helpers) ·
`:197-200` (el lado «legacy JS») · `:261-264` (el lado «SQL emulado») ·
`src/lib/likida/migraciones_verificadas.test.ts:75` (la exención que la cita) ·
`supabase/verificaciones.sql:6418-6426` y `:17101-17107` (los bloques 123 y 229)

**Escenario (medido, no razonado).** La exención de la 0317 dice que «la
corrección DE LAS FÓRMULAS … la fija la equivalencia JS-vs-RPC de
`fiscal_agregado.test.ts` (que **reimplementa cada fórmula de forma
independiente** y las compara contra el resultado agregado)». No es
independiente: **las dos mitades llaman a la MISMA función**. `legacyMapear`
(`:197`) y `sqlAgregadoEquivalente` (`:261`) invocan las dos
`renglonesAjenosDe`, `monedaExtranjeraDe`, `consumoBarDe`,
`complementoHidrocarburosFaltaDe` y `otroEjercicioDe`.

Lo comprobé rompiéndolo: cambié el cuerpo de `otroEjercicioDe` a `return false`
(M12) y luego el de `renglonesAjenosDe` (M13). En los dos casos
**`fiscal_agregado.test.ts` pasa 26/26**. Las viejas dimensiones sí se calculan
por separado en los dos lados (`sobre_tope`, `banda`, `totalTimbradoDia`,
`emisor`) — ahí la prueba sí muerde; las **seis que agregó la 0317**, no.

Y la otra pata de la exención tampoco cubre: los bloques 123 y 229 de la batería
llaman la RPC real, pero con valores elegidos **a propósito** para no disparar
ninguna de las causas nuevas — está escrito en el propio bloque: «se pasan … con
valores que NO disparan ninguna de las 7 causas nuevas sobre esta siembra».

Concreto: quita el término de tolerancia de enero de `otro_ejercicio` en
`0317…sql:150-153` (`- (case when extract(month from p_hoy) = 1 then 1 else 0
end)`). En enero de 2027, **todo** comprobante de 2026 sale marcado
`otroEjercicio` en la RPC, `ivaSostenible` (`fiscal.ts:1020`) devuelve `false` y
el panel del contador enseña **$0 de IVA acreditable de todo el ejercicio
anterior** el mes en que se presenta la declaración. `npm test` verde,
`ci-postgres` verde, y ninguna de las 12,174 pruebas se entera.

**Consecuencia.** Las siete banderas de la 0317 (`rfcReceptor`,
`rfcReceptorNoVerificable`, `monedaExtranjera`, `renglonesAjenos`, `consumoBar`,
`complementoHidrocarburosFalta`, `otroEjercicio`) deciden si el panel del
contador acredita o no el IVA de una celda, y **ninguna tiene un solo `expect`
que toque el SQL que las calcula**. Una prueba que congela un `f===f` es peor que
no tener prueba: es la que hizo que la 26 y la re-auditoría 25 dieran el rubro
por cubierto.

**Causa raíz probable:** al agregar las seis dimensiones se reusó el helper en
los dos lados «para no duplicar código», que es exactamente lo que la prueba
existe para no hacer.

---

### [ALTO · REINCIDENTE] El bloque 47 de `verificaciones.sql` sigue saliendo `✓ ok` con ocho de sus once mediciones sin calificar

`supabase/verificaciones.sql:2735` (el título) · `:2772` (el `do $$`) · `:2815`
(el `raise`) · `scripts/ci/calificar-verificacion.mjs:86-96`
(`partirEnClavesYEsperado`) y `:184-186` (el comodín)

**Escenario.** Corrí la función real `extraerBloques()` sobre los 242 bloques de
`verificaciones.sql` + `capa1_auditoria_estatica.sql` buscando la firma exacta
del defecto —un `%` después del marcador `(esperado`—. **Sigue habiendo
exactamente uno, y es el 47**, con **8 `%` después** del `(esperado 100 / 100 /
10)`. `partirEnClavesYEsperado` corta en el **primer** `(esperado`, el `der` se
traga el resto como si fuera el tercer valor esperado, ese valor trae espacios →
`calificar()` lo clasifica como prosa del autor (`:184`) → comodín, `ok: true`
incondicional. `llm_costo INTACTA`, `consolidado`, `crudo-de-meses-cerrados`,
`mes-en-curso-NO-consolidado`, `idempotente`, `plazo-minimo-falla-cerrado`,
`quedan` y `sqlstate` son decoración: solo `viejos-antes` y `purgados` se
comparan de verdad.

**Consecuencia.** La garantía de la 0072 —«`llm_costo` no se purga; se
consolida»— se corre en cada push, imprime una palomita y **no puede reprobar**.
`llm_costo` es de donde sale el costo de IA por flota que Javier mira en
`/admin` y el precio que va a ponerle a un cliente. El arreglo de la 26 (`66a08da`)
cerró el bloque 50 y su prueba ancla mira **solo el bloque 50**
(`calificar_verificacion_aud24.test.ts:119-123`): la forma que el calificador
exige —un único `(esperado …)`, al final— sigue sin estar escrita en ninguna
prueba general, así que ni el 47 se arregló ni el próximo se impide.

**Causa raíz probable:** se arregló el bloque, no la clase. (REINCIDENTE de la
26.)

---

### [MEDIO · REINCIDENTE] El trinquete de cobertura tiene ahora 4.3–7.9 puntos de holgura — más que en la 26, no menos

`vitest.config.ts:106-123` (el comentario «UN TRINQUETE, NO UNA ASPIRACIÓN … con
margen menor a un punto» y los cuatro umbrales) ·
`.github/workflows/ci.yml:76-77`

**Escenario (medido hoy).**

```
                 medido    umbral    holgura
statements       83.22       78       +5.22
branches         73.31       69       +4.31
functions        86.64       82       +4.64
lines            85.91       78       +7.91
```

La 26 midió 82.70 / 72.59 / 86.02 / 85.34 y reportó 3.6–7.3 de holgura. Trece
meses de commits después la holgura **creció**. Traducido a la regresión
realista —no borrar pruebas, sino no escribirlas—: `26,159/(35,681+X) = 0.69` →
caben **~2,230 puntos de rama nuevos sin una sola prueba** antes de que la puerta
se ponga roja (eran ~1,750 en la 26). El comentario que vive encima de los
umbrales sigue prometiendo «margen menor a un punto».

**Además, medido de paso:** cuando **cualquier** prueba falla, vitest **no
imprime el reporte de cobertura ni evalúa los umbrales**. En este contenedor
(sin loopback IPv6) `npm run test:coverage` nunca llega a la puerta: falla por
los 5 casos de infra y el trinquete no se evalúa. En CI no ocurre porque ahí sí
hay IPv6, pero significa que la puerta es la ÚLTIMA en evaluarse y la primera en
saltarse.

**Consecuencia.** El trinquete que la ronda 5 puso para que «12,174 pruebas»
dejara de medir esfuerzo volvió a medir esfuerzo. (REINCIDENTE de la 26.)

---

### [MEDIO · REINCIDENTE, ampliado] Las tres escrituras del registro de jornada (LFT 132-XXXIV) pueden perder sus candados y la suite completa queda verde

`src/lib/likida/jornada/repo.ts:524` (`anularAsiento`) · `:556` (`cerrarDia`) ·
`:588` (`sellarConformidad`)

**Escenario.** Apliqué las tres mutaciones a la vez y corrí la **suite entera**:
905 archivos, 12,174 pruebas, **exactamente los 5 fallos de infra de la línea
base, ni uno más**.

- `anularAsiento` sin `.is('anulado_en', null)`: la segunda anulación pisa el
  autor, la hora y el motivo de la primera (el comentario de `:501` promete lo
  contrario).
- `cerrarDia` sin `.eq('estado','abierto')`: un día ya cerrado se vuelve a
  cerrar con otro autor y otra hora; el mensaje «ya estaba cerrado» se vuelve
  inalcanzable.
- `sellarConformidad` sin `.is('conforme_operador_en', null)`: el mismo mensaje
  reentregado por Meta **mueve la hora del acuerdo del operador** — el candado
  que el propio comentario (`:582`) llama «el candado».

Ninguna de las tres se nombra en un solo `*.test.ts`. La 26 reportó `anularAsiento`;
las otras dos son la misma clase, en el mismo archivo, sin tocar.

**Consecuencia.** La LFT 132 fr. XXXIV, párrafo tercero, dice que el registro
«hará prueba plena si se acredita que fue acordado». Un rastro cuyo sello de
acuerdo se puede reescribir en silencio no es prueba plena de nada — y el módulo
está en el camino de WhatsApp (`processor.ts:944` llama `asientosDeJornada`).

**Causa raíz probable:** el módulo se probó por donde se leía (el export, el
orden de los asientos) y las escrituras quedaron del otro lado de la frontera.
(REINCIDENTE de la 26.)

---

### [MEDIO] La aprobación de una factura de proveedor puede perder su candado de idempotencia sin que nada se ponga rojo

`src/lib/likida/proveedores.ts:322` · comentario en `:307-310` · llamada en
`src/app/dashboard/agentes/proveedores/page.tsx:183`

**Escenario.** Borro `.eq('estado', 'pendiente')` del `update` de
`decidirFacturaProveedor`. **Suite completa: 5 fallos, la línea base.** Con la
mutación, el contador aprueba una factura de proveedor, el encargado abre la
misma pantalla con la caché vieja y pulsa «Rechazar»: la segunda escritura pisa
el estado, el `decidido_por` y el `decidido_en` de la primera, y la respuesta
«Esa factura ya no está pendiente — alguien más la decidió. Recarga la página»
—el mensaje que el propio código escribe en `:326`— se vuelve inalcanzable. Ese
`decidido_por`/`decidido_en` es lo que sale en las tres plantillas de export
(`aFilaExportProveedor`, `aFilaSapB1`, `aFilaContpaqi`), o sea que va al sistema
contable del cliente diciendo quién aprobó.

`proveedores.test.ts` sí existe: prueba los tres layouts de export
(`aFilaExportProveedor`, `aFilaSapB1`, `aFilaContpaqi`) y el parseo del XML.
Ninguna prueba del repo nombra `decidirFacturaProveedor` ni
`listarFacturasProveedor`.

**Causa raíz probable:** el módulo se probó por su parte pura (los layouts) y la
escritura quedó fuera; la puerta de cobertura no lo nota por la holgura del
hallazgo anterior.

---

### [BAJO · REINCIDENTE] `contarConCfdi` puede devolver `0` cuando la base falla y nada se pone rojo

`src/lib/likida/facturacion/pendientes.ts:221` · consumida en
`src/app/dashboard/agentes/facturas/page.tsx:48`

**Escenario.** En la rama de error cambio `return null;` por `return 0;`. Suite
completa: línea base, 0 fallos nuevos. El comentario de la función dice
textualmente «`null` ≠ 0: si no se pudo contar, se dice» (`:211`), y la página
que la consume declara «base caída = página caída, no una lista vacía que afirma
"todo facturado" estando ciega». Con la mutación el contralor lee «0 con CFDI» y
sale a reclamarle a su equipo por un mes de facturas que sí existen. Es la regla
que define al producto sin un solo `expect` que la sostenga. (REINCIDENTE de la 26,
sin tocar.)

---

### [BAJO · REINCIDENTE] `sat_descarga/escritura.ts` sigue sin un solo archivo de prueba

`src/lib/likida/sat_descarga/escritura.ts:157` · consumida en
`src/app/dashboard/descarga-sat/vista.tsx:126`

**Escenario.** Cambio `if (!cfg.activa) …` por `if (false) …`. Suite completa:
línea base. Una flota con la descarga **pausada a propósito** vuelve a abrir
solicitudes ante el SAT desde el botón de «pedir un rango a mano», y el mensaje
de la función de al lado explica el costo: «reintentarlo consume el tope diario
del RFC». Cero pruebas nombran `guardarConfigDescarga`, `verificarCredencial` ni
`pedirRangoManual`. Sigue en BAJO por la misma razón medida de la 26: la parte
que de verdad hacía daño —el `update` sin `.eq('tenant_id')`— sí la caza el
escáner `consultas_admin_filtran_tenant.test.ts`. (REINCIDENTE de la 26.)

---

### [BAJO] Una prueba que solo corre donde hay loopback IPv6, sin `skipIf` y sin declararlo en ningún lado

`scripts/ci/e2e/proxy-local.test.ts:21` (`servidor.listen({ port: 0, host,
ipv6Only: host === '::1' })`) y `:14-26` (`destino()`, la fábrica del canario)

**Escenario.** Cinco de sus casos exigen escuchar en `::1`. En un contenedor sin
loopback IPv6 —el de esta nube, y el de cualquier runner con IPv6 apagado— la
suite entera sale **roja con 5 fallos** que no son del repo, y como efecto
colateral `npm run test:coverage` nunca llega a evaluar sus umbrales (vitest no
imprime cobertura si algo falló). El repo tiene el mecanismo exacto para esto —
`it.skipIf` con su red de vigilancia en `pruebas_en_ci.test.ts:38-72`, que exige
que lo saltado se corra en otro paso de CI— y aquí no se usó, ni el requisito
está escrito en el archivo, en el README ni en `CLAUDE.md`.

**Consecuencia.** Cada agente y cada persona que clone en un entorno sin IPv6
tiene que descubrir por su cuenta que esos 5 no cuentan; el MAPA de esta ronda
gasta un párrafo entero en decirlo. Una compuerta que hay que explicar deja de
ser compuerta: el hábito de leer «5 en rojo, son los de siempre» es exactamente
cómo se cuela el sexto.

**Causa raíz probable:** la prueba se escribió en una máquina con IPv6 y el
requisito nunca se declaró.

---

## Lo que revisé y está bien

- **Los 12 arreglos de esta ronda que mutué murieron los 12** (M1–M11, M14–M15).
  Vale la pena nombrar tres: M9 muere con un `it` cuyo nombre **es** la garantía
  («el PDF que se le manda al jefe es el COMPLETO, no el `-operador.pdf`»,
  `processor_cierre.test.ts`); M6 mata siete casos a la vez; y M11 —revertir el
  fix del QR de zxing— la caza `codigos.test.ts` con la **foto real de campo**
  del ticket de Office Depot, sin que el commit haya tenido que escribir prueba
  nueva. Eso es un fixture haciendo su trabajo años después.
- **La asimetría del REP `FormaDePagoP='99'` que la continuación de la 26 dejó
  abierta ESTÁ CERRADA, y la aserción que la congelaba se volteó.**
  `fiscal_agregado_15pct.test.ts:56-61` ya exige `forma_pago_efectiva <> '99'`
  donde antes exigía `not.toContain('99')`, y la 0345 lo implementa
  (`0345_combustible_rep_por_definir.sql:29`). Es el único caso que encontré de
  una prueba que fijaba un bug y **se corrigió en el mismo commit que el bug**
  (`6cbac00f`) — que es como se hace.
- **Los 8 bloques nuevos de `verificaciones.sql` (229 → 237) afirman de
  verdad**: siembran filas reales, llaman la función real y comparan valores
  concretos (`CAPACIDAD_0319 … 5000 / 80 / 80 / 2 / 2 / 0 / f / t`;
  `DB_RETENCION_0332 producto=t deadline=t geo=t llaves=t`, con un evento de 120
  días y un `sum(eventos)=1`). No encontré uno que solo cuente filas. La única
  sub-medición vacua que vi es `sin-escrituras` del bloque 266 (compara conteos
  que son 0 antes y después en base virgen), y su gemela `estable` —que exige
  `provolatile='s'`— la cubre.
- **El barrido de los 242 bloques con `calificar()` real**: ninguno cae en
  `sin_calificar` (que sí sería rojo) y **solo el 47** tiene la firma del
  defecto. El mecanismo del comodín no está mal; el bloque 47 sí.
- **La numeración de migraciones sigue disciplinada**: la 0343 falta a propósito
  y `NUMERACION-SALTADA.md` existe; `migraciones_verificadas.test.ts` prohíbe
  exenciones fantasma y las 12 migraciones nuevas tienen las dos cosas que exige
  (bloque o razón). El problema no es el mecanismo, es lo que la razón puede
  decir sin que nadie lo verifique (ver el ALTO).
- **La disciplina de commit sigue alta**: de los **180 commits que tocan `src/`**
  desde `a3c1560`, **14 no traen ningún `*.test.ts`** — y de esos 14, siete son
  cambios de sólo-prosa/UI (`8f1b1d30` un rótulo, `3d973998` tres clases de CSS,
  `f85e68f3` fichas de `normas/`), dos son ratchets de baseline y uno
  (`0698e904`, el QR) ya estaba cubierto por un fixture previo, lo comprobé
  mutando. El que sí dejó deuda es `b349b724` (el esquema del OCR) y es el
  CRÍTICO de arriba.
- **El escáner de aislamiento por tenant sigue mordiendo por catálogo**
  (`supabase/pruebas-aislamiento/consultas_admin_filtran_tenant.test.ts`), no
  por lista escrita a mano: es lo que salva a `sat_descarga/escritura.ts` de ser
  un MEDIO.
- **`pruebas-manuales/` sigue sin poder colarse**: 25 archivos `*.prueba.ts`,
  todos fuera del `include` de vitest; ninguno se ejecutó, ni con `--coverage`.
  `vitest.audit.config.ts` y `vitest.qa.config.ts` no los invoca ningún workflow.
  El único `describe.skip` vivo (`arnes_ticket_real.test.ts:371`) se salta por
  ausencia de fotos reales, no por bandera, y ésa es la «1 saltada» de la línea
  base.
- **La red de `skipIf` sí es una red**: `pruebas_en_ci.test.ts` detecta el salto
  sobre el código **sin comentarios** (para no detectarse a sí misma), exige que
  el filtro esté en el paso «Pruebas de tiempo» de `ci.yml`, y comprueba que
  `vitest.config.ts` exporte **la misma** bandera que los `skipIf` leen — el modo
  de falla exacto de la auditoría 3. Es el mejor mecanismo del rubro; el ALTO de
  los arneses SQL es que no se aplicó a `supabase/tests/`.
- **El fixture `poliza342_rpc.json` está bien hecho**: se capturó de una corrida
  real de `supabase/tests/0342_…sql` contra Postgres, trae su README con el
  procedimiento de regeneración y la advertencia de que «no sustituye ejecutar
  la prueba SQL tras una migración». Verifiqué que sus `fecha: null` en gastos
  **sí** son producibles (`0001:62`, columna nullable). No es un fixture
  imposible.
- **La ruta del PDF dejó de ser dos literales y pasó a ser una función tipada**
  (`liquidacion/rutas_pdf.ts`), y aunque el escáner estático de la auditoría 5
  se retiró (`ruta_pdf_sincronizada.test.ts` bajó de 116 a 18 líneas), la
  garantía que protegía —el chofer recibe el ejemplar del operador— **sigue
  anclada por comportamiento**: M9 la mata en 4 casos.

---

## Lo que NO alcancé a revisar

- **No corrí la batería SQL contra un Postgres real.** No hay `postgres` ni
  `initdb` en este contenedor (lo intenté). Todo lo que digo de
  `verificaciones.sql` es el barrido estático con la función `calificar()` real
  sobre los 242 bloques; **no sé si alguno mide algo vacuo** (sembrar cero filas
  y afirmar `0 = 0`), y esa clase solo se caza mutando el producto bloque por
  bloque. La 26 sí pudo levantar Postgres; yo no.
- **Por lo mismo, no ejecuté ninguno de los 29 arneses huérfanos**: sé que nadie
  los corre y leí dos por dentro; **no sé si pasarían**. Es posible que alguno
  lleve semanas roto — que es precisamente lo que la primera corrida de
  `ci-postgres.yml` encontró en 2026 con `verificaciones.sql`.
- **No probé la Capa 0 (`wa_leases_fencing.sql`, pgTAP)** ni `playwright-smoke`,
  `e2e-navegador.yml` ni `scripts/ci/e2e/` más allá del archivo de IPv6.
  `pg_prove` y el navegador no aplican aquí. Cuarta ronda seguida que quedan
  fuera.
- **No corrí la suite bajo otros husos horarios.** La 26 lo hizo (UTC+14 y
  UTC−11, 858/858 verde) y no reprodujo intermitencia; asumí ese resultado en
  vez de gastar dos corridas de 3 minutos, y eso es una suposición, no una
  medición de esta ronda.
- **No medí cobertura POR ARCHIVO**, solo el resumen global. El sustituto fue el
  barrido de nombres: **224 funciones exportadas de `lib/likida`, `lib/admin` y
  `lib/saas` cuyo identificador no aparece en ningún archivo de prueba** (eran
  222 en la 26 — no bajó). De ésas revisé a fondo cinco escrituras; las otras
  ~40 que huelen a escritura de dinero (`autorizarRelogin`, `revocarRelogin`,
  `guardarMercancia`, `marcarProveedorVerificado`, `aplicarTurnoEntrevista`,
  `cerrarFoto`…) quedaron sin mutar.
- **De las 12 migraciones nuevas (0319→0347) mutué cero en SQL**, por lo mismo:
  sin base. Mi juicio sobre su cobertura es estructural (quién las ejecuta, qué
  afirman sus bloques), no experimental.
- **El árbol se movió debajo de mí**: arranqué en `06b2eca4` y terminé en
  `e8a53f78` (cinco commits de docs de esta misma ronda más `5569437e`, que toca
  `salud-produccion.yml` y `compuerta_deploy_aud24.test.ts`). Verifiqué que
  ninguno toca los archivos de mis hallazgos, pero **todas mis cifras de verde,
  cobertura y mutación son de `06b2eca4`**.

---

## Árbol limpio

Las 21 mutaciones corrieron en un `git worktree --detach` bajo el scratchpad,
con `node_modules` por symlink; el worktree quedó **borrado**
(`git worktree list` → una sola entrada). No toqué ni un archivo del árbol de
trabajo; el único que este rubro agrega es `docs/auditoria-27/pruebas.md`.
