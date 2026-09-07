# Arquitectura y mantenibilidad — auditoría 28

**Nota: 3/10** (antes 4). Razón del movimiento: **mirada más profunda**. El
código de este rubro no cambió —ni un commit de los tres de la ventana toca
`src/lib`, `supabase/` ni los guardias— y los diez hallazgos que la 27 dejó
abiertos siguen ahí, verificados uno por uno. Lo que se movió es la evidencia:
**medí los guardias estructurales que sostenían la nota y miden una unidad que
no es la propiedad que protegen**. La 27 escribió, en «lo que está bien», que
«la frontera de datos aguantó 181 commits sin una sola fuga nueva: 252 de 252»
y que «las dependencias que apuntan al revés siguen siendo dos». Las dos frases
son artefactos de medición: el guardia de la frontera cuenta **archivos**, no
consultas, y está saturado exactamente en su techo, mientras el acceso directo
real creció de **1,180 a 1,277 llamadas** desde que ese guardia nació; y las
dependencias invertidas son **tres**, no dos, porque el `grep` que las contó no
puede ver un `import()` dinámico. No es que empeorara: es que se vio mejor.

Sigue en el rango 3–4 del ancla del rubro por lo de siempre —el predicado del
15 % vive en cinco implementaciones y la póliza tras `ajustar` sigue rota—, y
baja a 3 porque hoy puedo señalar **el camino concreto** por el que el producto
hace algo mal y nadie se entera: una lectura sin cota en el motor del dinero,
que apaga en silencio un control fiscal, y que entró sin que ninguno de los seis
guardias parpadeara.

**El riesgo mayor del rubro, hoy:** la arquitectura que CLAUDE.md vende
(«todo el acceso a datos pasa por `repo.ts`/`pg.ts`») cubre el **3.9 %** del
acceso real (52 de 1,329 llamadas `.from(`/`.rpc(`), y el único mecanismo que
dice contenerla no puede ver crecer el otro 96 %.

> **Método.** Todas las cifras se midieron en esta ronda contra `d56e626` (HEAD
> de `claude/auditoria-28`), con scripts propios sobre el árbol y sobre el
> historial (`git show <sha>:<archivo>`), no recordadas. `npx tsc --noEmit -p .`
> → exit 0. Corrí los cinco guardias estructurales (`frontera_datos_guardiana`,
> `tope_consulta`, `contencion_listas`, `rol_label_unico`,
> `fiscal_agregado_15pct`): **23 pruebas, todas verdes** — el punto de tres de
> mis hallazgos es justamente que están verdes. No edité ningún archivo del
> repo fuera de este documento. La base está en cero y no hay credenciales: la
> aritmética de los escenarios es aritmética sobre el SQL y el TypeScript
> leídos, no filas contadas.

---

## Hallazgos nuevos — un tema: los guardias miden la unidad equivocada

### [ALTO] El guardia de la frontera de datos cuenta ARCHIVOS, está saturado en su techo, y +97 accesos directos entraron sin que nada se pusiera rojo

`src/lib/likida/frontera_datos_guardiana.test.ts:53`
(`TECHO_ARCHIVOS_FUERA_DE_LA_FRONTERA = 252`) · `:66-77` (el barrido: cuenta un
archivo si contiene **al menos un** `.from(`/`.rpc(`) · `:97-106` (la única
aserción que puede fallar) · `:108-115` (el tercer test, que asegura
`archivos.length > 0` — no puede fallar nunca).

**La medición.** Reconstruí el barrido del guardia con su mismo criterio
(`src/**/*.ts(x)` sin `.test.`/`.fixture.`/`pruebas-manuales`, menos `repo.ts` y
`pg.ts`) y lo corrí sobre cuatro puntos del historial, contando además las
**llamadas**, no solo los archivos:

| Fecha | Sha | Archivos fuera de la frontera | Llamadas `.from(`/`.rpc(` | Guardia |
|---|---|---|---|---|
| 29-ago | `af31b35` (nace el guardia) | 241 | 1,180 | verde |
| 02-sep | `b8a1a3a` | 251 | 1,250 | verde |
| 03-sep | `d914e74` (techo → 252) | 252 | 1,257 | verde |
| 04-sep | `697f738` | 252 | 1,262 | verde |
| **07-sep** | `d56e626` (**hoy**) | **252** | **1,277** | **verde** |

**Escenario, con los valores del propio repo.** Entre el 3 y el 7 de septiembre
un mantenedor agregó **10 accesos directos nuevos a Supabase** en
`src/lib/likida/conectores/sincronizar_eventos.ts` (de 5 a 15 llamadas), 5 en
`src/lib/admin/calcom.ts` (2 → 7), 3 en `src/lib/correo/respuesta_campana.ts`
(3 → 6) y 3 en `src/lib/likida/wa_pendientes.ts` (9 → 12) → el guardia imprime
**«252 de 252 — dentro del techo»** y la suite queda verde, porque ninguno creó
un archivo nuevo. El techo está **saturado al valor exacto del conteo**, así que
el costo marginal de una consulta nueva dentro de un archivo que ya cuenta es
**cero**, y el costo de un módulo nuevo con acceso a datos es editar una
constante: el gradiente empuja las consultas hacia los archivos grandes que ya
están dentro —`processor.ts` es el caso obvio, 8 llamadas y 4,603 líneas.

**Consecuencia.** Para el equipo que va a mantener esto: la propiedad que
CLAUDE.md declara —«todo el acceso a datos pasa por `repo.ts`»— hoy cubre
**52 de 1,329 llamadas (3.9 %)**, y el instrumento que la vigila no puede medir
su erosión. Y para las dos rondas anteriores de esta auditoría: el «252 de 252,
sin una sola fuga nueva» que sostuvo la nota era un número que no habla de
fugas. La segunda consecuencia es directa y la reporto abajo: con 1,277
llamadas escritas a mano fuera de la frontera, cada una re-implementa por su
cuenta los dos bordes de PostgREST que `pg.ts:12-46` documenta, y **una de ellas
está en el motor del dinero**.

**Intento de refutación.** (a) ¿El guardia dice explícitamente que cuenta
archivos? Sí, y ese es el punto: es honesto en su encabezado y **la auditoría lo
leyó como si midiera acceso** dos rondas seguidas. (b) ¿Existe otro guardia que
cuente llamadas? No: barrí los 31 archivos de prueba que leen el árbol
(`readdirSync`) y ninguno cuenta `.from(`/`.rpc(` por llamada. (c) ¿El techo
protege algo? Protege contra **archivos** nuevos, y eso sí funcionó (se movió a
mano dos veces, 241 → 251 → 252). Lo que no protege es contra el crecimiento
donde de hecho ocurrió.

**Causa raíz probable:** el guardia se diseñó para no repetir el error de la
lista literal (`acotada_guardiana.test.ts`) y eligió la unidad más barata de
barrer —el archivo— en vez de la unidad de la propiedad —la consulta.

---

### [ALTO] Lo que esa ceguera deja pasar: la lectura de líneas ECC del motor de cuadre no tiene cota, y a las 1,000 filas apaga en silencio un control fiscal

`src/lib/likida/cuadre/desde_db.ts:232-250` (`lineasEccParaCuadre`: `.select` con
`.eq('tenant_id')`, `.eq('fuente','ecc12')`, `.gte/.lte('fecha')` — **sin
`.limit()`, sin `.range()`, sin `.order()`, sin `count`, y sin pasar por
`traerTodo`**) · `:205-207` (dónde se inyecta al cuadre) ·
`src/lib/likida/cuadre/engine.ts:716-723` (`evidenciaMonedero` → diferencia
`ticket_monedero`) · `:377` (`POR_CONFIRMAR` incluye `ticket_monedero`) ·
`src/lib/likida/intake/evidencia_monedero.ts:76-87` (el `find` que exige la
línea exacta) · `src/lib/likida/pg.ts:45` (`PAGINA = 1_000`), `:78`
(`LecturaIncompleta`), `:183` (`traerTodo`) · **`src/lib/likida/analytics.ts:1725-1742`**
(la lección, escrita sobre **la misma tabla**).

**Escenario, con valores.** Flota con monedero electrónico, 120 unidades que
cargan diésel a diario → `cfdi_consolidado_linea` recibe ~120 filas
`fuente = 'ecc12'` por día. Viaje V-880 con comprobantes fechados entre el
2026-03-02 y el 2026-03-12: la ventana que arma `:247-248` es
`[2026-03-01, 2026-03-13]` = 13 días × 120 = **1,560 líneas del tenant**.

PostgREST devuelve **1,000** (`max_rows`), sin error, sin aviso y —al no haber
`.order()`— **en el orden que Postgres quiera**. La línea que corresponde al
ticket de diésel de **$9,400.00** del 2026-03-09 en la estación
`PEM8501015S3` queda fuera del corte. Entonces:

- `evidenciaMonedero` (`:76-87`) no encuentra `estación + monto ±$1 + fecha ±1 día`
  y devuelve `{ tipo: 'ninguna' }`;
- `engine.ts:718` no emite la diferencia `ticket_monedero`;
- los **$9,400** se quedan en la cubeta **deducible** y la liquidación cierra
  **«cuadrada»** en vez de irse a `revisar` (`ticket_monedero` ∈ `POR_CONFIRMAR`,
  `:377`, y `POR_CONFIRMAR ⊂ REVISAR` por `contencion_listas`).

Con la lectura completa, esos $9,400 salen de deducible y la liquidación va a
revisión humana. Entra **una flota que rebasa 1,000 líneas ECC en la ventana** →
sale **un ticket de bomba tratado como comprobante deducible**, que es
exactamente lo que la RMF 2026 3.3.1.7 prohíbe (la estación no debe facturarlo;
el comprobante es el CFDI del emisor con complemento ECC).

**Consecuencia.** El contralor deduce para ISR un importe que el SAT no admite,
y el producto no solo no lo advierte: le dijo «cuadrada» en verde. El defecto es
**silencioso por construcción** — el `catch` de `:207` solo ve errores, y un
recorte no es un error, así que ni siquiera hay `logger.warn`. Empeora con el
tamaño de la flota, es decir con el cliente que más vale.

**Intento de refutación.** (a) ¿Lo cubre el modo estricto? No:
`cierreEstricto` (`:57`, `:132`) convierte el fallo en excepción, y aquí no hay
fallo. (b) ¿Lo cubre el padrón? No: el camino A
(`estaEnPadronMonederos`) solo acierta cuando el ticket trae el RFC del **emisor**
del monedero; el propio encabezado (`evidencia_monedero.ts:13-17`) explica que
los tickets de bomba imprimen el RFC de la **estación**, que es justo el caso que
depende del camino B. (c) ¿Es un riesgo teórico? No: el repo ya se tropezó con
esto **en esta misma tabla** y lo dejó escrito en `analytics.ts:1725-1734`
(«*PostgREST aplica `min(limit, max_rows)`… y SIN `.order()`, esas 1,000 eran las
que Postgres quisiera*»), y ahí sí puso `.order()` + `.limit(1000)` (`:1738-1742`).
La lección está a 200 líneas de distancia, en otro archivo, y el camino del
dinero se escribió después sin ella. (d) ¿Y el helper? `traerTodo` + `conteo` +
`LecturaIncompleta` existen en `pg.ts` para exactamente esto y este sitio no los
usa — una de las 1,277 llamadas que el guardia del hallazgo anterior no ve.

**Causa raíz probable:** la FASE 2 movió el filtro de memoria al `WHERE` por
rendimiento (`:224-231`) y al hacerlo convirtió una lista ya acotada por el
viaje en una lectura de tabla del tenant entero, sin heredar la disciplina de
paginación que la frontera declarada sí tiene.

---

### [MEDIO] «Ninguna consulta del cierre se queda sin techo» lo garantiza una lista de cuatro archivos, y `processor.ts` —donde ocurre el cierre— no está en ella

`src/lib/likida/tope_consulta.test.ts:25-30` (`CAMINO_DEL_CIERRE` = `repo.ts`,
`conv.ts`, `costos.ts`, `config.ts`) · `:33-48` (la aserción) ·
`src/lib/likida/processor.ts:172`, `:176`, `:332` (tres consultas crudas) ·
`src/lib/likida/presupuesto.ts:76` (`TOPE_CONSULTA_MS = 8_000`) ·
`src/lib/supabase/admin.ts:18` y `:33-38` (el backstop de 25 s).

**La medición.** Apliqué el **regex del propio guardia**
(`await supabaseAdmin()` + `await admin.(rpc|from)(`, sobre el fuente sin
comentarios) a todo `src/`: **203 consultas crudas en 75 archivos de
producción**. El guardia mira 4. Entre los 75 está `processor.ts`, el archivo
del webhook cuyo modo de falla el encabezado del guardia describe literalmente
(`:13-17`: «*la liquidación queda escrita, el operador no recibe ni resumen ni
PDF… y Meta no reintenta porque ya recibió su 200*»).

**Escenario, con valores.** El chofer manda su pin de ubicación →
`registrarUbicacionChofer` (`processor.ts:169-190`) hace dos consultas crudas
—`select` sobre `viaje` (`:172`) e `insert` en `posicion` (`:176`)— sin
`acotada`. Con la base lenta, cada una corre hasta el backstop de **25 s** en
vez de los **8 s** del tope fino: hasta **50 s de los 120 s** de la invocación
consumidos por una pata que el propio comentario declara *best-effort*, en la
misma invocación donde después hay que cuadrar y mandar el PDF.

**Consecuencia.** Degradación que se nota (el operador espera y a veces no
recibe el cierre) y, sobre todo, un guardia cuyo nombre y cuya aserción afirman
una propiedad —«el camino del cierre»— que no cubren el archivo del cierre.

**Intento de refutación — y me refuté a medias.** Busqué el guardarraíl y existe:
`supabase/admin.ts:18` pone un `AbortSignal.timeout(25_000)` en el `fetch` de
**todo** el cliente, así que ninguna consulta cuelga hasta los 300 s de undici.
Eso baja esto de ALTO a MEDIO y hay que decirlo: el desastre que el guardia
describe ya no es alcanzable. Lo que queda es lo del rubro — un mecanismo
declarado como cobertura general implementado como lista literal de cuatro
rutas, que es **el modo de falla que este mismo repo documenta como el que mató
a `acotada_guardiana.test.ts`** (citado en
`frontera_datos_guardiana.test.ts:8-13`) reproducido veinte líneas más allá.

---

### [BAJO] Las dependencias invertidas son tres, no dos: el método con que se contaron no puede ver un `import()` dinámico

`src/lib/admin/calcom.ts:489` (`const { POST } = await import('@/app/api/webhook/calcom/route');`
y `:490-495`, que fabrica el HMAC y ejecuta el handler) ·
`src/app/api/webhook/calcom/route.ts:6` (que a su vez importa
`@/lib/admin/calcom`) · las dos ya conocidas:
`src/lib/likida/oficina_wa.ts:7` y `src/lib/mcp/credencial.ts:20`.

**La medición.** Construí el grafo de módulos de producción (819 archivos,
resolviendo `@/`, rutas relativas, `index.ts` **y `import()` dinámico**) y conté
las aristas `src/lib/** → src/app/**`: **3**. El `grep -rn "from '@/app/"` con
que la 27 certificó «siguen siendo dos» no puede ver la tercera, porque es
dinámica. Sobre el mismo grafo: **8 ciclos de importación reales** (componentes
fuertemente conexos de tamaño > 1), el mayor de seis módulos
—`asistencia_proveedor` → `asistencia_wa` → `operacion` → `briefing_inicio_wa`
→ `relojes_legales` → `administracion`—, más
`logger ↔ observability/sentry` (deliberado y roto por `import()` dinámico,
`logger.ts:190`), `agentes/faq ↔ exito`, `agentes/contenido ↔ crecimiento`,
`ingenieria_producto ↔ ingenieria ↔ runner`, `facturacion/adaptadores/pasos ↔
playwright_base ↔ vinculo_senales` y `admin/qa/[id]/medicion-corrida ↔
corrida-viva`.

**Escenario (el del rubro: el mantenedor cambia X y Y se queda viejo).** Alguien
endurece el webhook público de Cal.com —añade una comprobación de recencia sobre
un encabezado de timestamp, o cambia el esquema de firma— en
`app/api/webhook/calcom/route.ts`. La entrega local del cron
(`calcom.ts:485-495`) arma su `Request` a mano con exactamente dos encabezados
(`content-type` y `x-cal-signature-256`) → o empieza a recibir 4xx y el cron
tira `Cal.com entrega local falló` en cada corrida, o —si el control nuevo vive
en el proxy y no en el handler— la ruta local **lo salta sin enterarse**. Nada
en el repo ata las dos mitades: no hay prueba que ejecute los dos caminos contra
el mismo contrato.

**Consecuencia.** Deuda que va a cobrar: una librería que ejecuta un handler HTTP
invierte la capa, mete el módulo de ruta en el bundle del cron, y deja un
contrato implícito (los encabezados que el handler exige) sin dueño ni prueba.
Es BAJO porque hoy funciona y está documentado en su comentario; lo que no está
documentado es que **la medición que certifica la capa es ciega por
construcción**.

---

## Los diez hallazgos de la 27, verificados hoy: cero cerrados

Los abrí uno por uno contra `d56e626`. Ninguno de los tres commits de la ventana
toca estos archivos, así que la reincidencia es por construcción y **no la
vuelvo a narrar** — lo que aporta es la verificación, no la repetición.

| Sev. | Hallazgo | Verificación de hoy |
|---|---|---|
| **CRÍTICO** (6ª aparición desde la 24) | La póliza tras `ajustar`: un ajuste firmado inhabilita el export contable del **periodo completo** (409 para las 40 liquidaciones del mes) | `export/poliza/route.ts:117` (`ajustesIncompatibles`) y `:364` intactos. **Sigue sin una sola prueba**: `ls src/app/api/export/poliza/` → `fixtures`, `rol_dinero.test.ts`, `salida.test.ts`, `salida_sap_b1_aud24.test.ts`, y ninguno la menciona |
| ALTO | La regla «una foto repetida no es un gasto» no existe en los agregados SQL del cubo del 15 % | `grep -c "folio_norm\|distinct"` sobre `0345_combustible_rep_por_definir.sql` → **0**. Sin cambios |
| ALTO | `proporcionCombustible15` acredita IVA con una proporción agregada y el comentario la declara exacta | `fiscal.ts:524` y el bloque `:506-523` idénticos |
| ALTO | `leerValorDelMes` manda al cliente el IVA del mes **sin filtrar `revision`** | `agentes/exito.ts:685-695`: el `select` sigue sin traer ni filtrar `revision`; sigue el rótulo que promete la misma columna que la RPC 0308 |
| MEDIO | El predicado «es combustible del ejercicio» en **cinco** implementaciones | Las cinco vivas: `0345:24`, `0317:139`, `engine.ts:694`, `fiscal.ts:679`, `desde_db.ts:173`. `fiscal_agregado_15pct.test.ts` sigue fijando la ruta SQL a mano |
| MEDIO | «¿Este destino es interno?» con dos implementaciones y dos suites verdes | `investigador.ts:157` (`esIpPrivada`) y `:176` (`hostPublico`) sin tocar |
| BAJO | `estadoRenglon` reconstruye `cubetaDe` sin llamarla | `dashboard/[id]/vista.tsx:199` intacto |
| BAJO (6ª ronda) | `procesarTurno` | `processor.ts:1351` → 4,603 = **3,253 líneas**, exactamente igual que la 27. Dejó de crecer; no se extrajo nada |
| BAJO | El encabezado de `revision.ts` declara dos contratos que su archivo rompe | `revision.ts:9` y `:18-20` literales |
| BAJO | `ROL_BADGE`, la quinta copia del dominio de roles | `dashboard/chrome.tsx:29` y `:107` sin cambios; `rol_label_unico` sigue casando por nombre y sigue verde |

---

## Lo que revisé y está bien

- **El borde de «fallar cerrado» sí se sostiene, y lo medí.** Barrí las **1,103**
  llamadas `.from(` de producción buscando las que ignoran `error`: 44
  candidatas, y al abrirlas **todas menos un puñado eran falsos positivos de mi
  regex** (usan `exigirLectura(...)`, p. ej. las once de
  `likida/reglas/lectores.ts:105-393`, o `exigir()` de `pg.ts:32`). No encontré
  una sola lectura de dinero que convierta un error en «no hay nada». Es la
  regla que CLAUDE.md pone primero y es la mejor cumplida del repo.
- **La cota de filas está mejor de lo que temía.** De 1,103 llamadas: 369 son
  mutaciones, 215 `single()/maybeSingle()`, 322 traen `.limit()`/`.range()`, 62
  son `head: true`, 21 van dentro de `traerTodo`. Quedan **76 lecturas de lista
  sin cota**, y las abrí una por una: casi todas son catálogos pequeños
  (`plan`, `interruptor`, `conector_credencial`, buckets de Storage) o listas ya
  acotadas por `.in(ids)` con un lote de arriba. **La única que no pude
  descartar es `desde_db.ts:242`** — es el hallazgo ALTO de arriba.
- **La frontera del tenant no tiene una fuga que yo pueda demostrar.** Extraje
  de las 324 migraciones las **100 tablas con `tenant_id`** y crucé cada
  `.from()` de producción contra ellas: 147 sitios sin `tenant_id` en su bloque.
  Los abrí; los que tocan datos de flota resultaron sanos —`clientes.ts:880`
  inyecta el tenant vía `filaTarifa(tenantId, …)`, `conv.ts:1032` lee dos
  contadores por UUID de viaje— y el resto son tablas globales de Likida a
  propósito (`prospecto`, `cola_aprobacion`, `agente_corrida`, el CRM y los
  agentes internos) o `/admin`, que cruza tenants por diseño. **Ojo: ningún
  guardia comprueba esto**; hoy sale limpio por disciplina, no por mecanismo.
- **Las trampas declaradas muertas siguen muertas.** `gasto.ocr_raw` solo
  aparece en tres comentarios que advierten que lo está
  (`analytics.ts:719-720`, `facturacion/flota_fiscal.ts:19`); `politica_gasto`
  en cinco comentarios y cero consultas; `envio_mensaje` y `portal_credencial`
  en cero archivos de producción. El repo documenta sus cadáveres mejor que
  ningún otro que haya auditado.
- **Las rutas literales dentro de los guardias no están podridas.** Extraje las
  **206** rutas de archivo escritas a mano en los 880 archivos de prueba: 6 no
  existen, y las abrí todas — son referencias en prosa
  (`docs/auditoria-10/rendimiento.md`, `supabase/server.ts` como nombre corto),
  no rutas que un `readFileSync` vaya a leer. La excepción sigue siendo la de la
  27: `fiscal_agregado_15pct.test.ts` fija la migración vigente por nombre.
- **`npx tsc --noEmit -p .` → exit 0**, y los cinco guardias estructurales
  corren verdes (23 pruebas).

---

## Lo que NO alcancé a revisar

- **Los 8 ciclos de importación, por dentro.** Los medí y los enumeré, pero solo
  verifiqué que el de `logger ↔ sentry` está roto a propósito con un `import()`
  diferido (`logger.ts:190`). **No comprobé si alguno evalúa un binding del
  socio en el cuerpo del módulo** —el caso en que un ciclo revienta con
  «Cannot access before initialization» en producción y no en la prueba, según
  quién importe primero—. Es el trabajo natural de la próxima ronda sobre este
  tema: el cluster de seis (`asistencia_wa`/`operacion`/`administracion`/…) es
  el candidato.
- **`conectores/sincronizar_eventos.ts`.** Pendiente por segunda ronda. Es el
  archivo que más creció y el que aportó **10 de los 20** accesos directos
  nuevos de la ventana; no leí qué hace con ellos ni si duplicó un criterio de
  geocerca o de «evento de seguridad».
- **Las migraciones 0319-0347 y qué funciones redefine cada `create or
  replace`.** Igual que la 27. Solo abrí 0317 y 0345 por el predicado del 15 %.
- **Un detector de clones por CONTENIDO.** Mi barrido sigue siendo por nombre de
  símbolo y por predicado buscado a mano. Las cuatro `forma.tsx` y las tres
  `Plegable` que la 24 marcó siguen sin evaluarse.
- **`lib/mcp/herramientas/*` contra `/v1/*`.** Pendiente desde la 26.
- **Nada que requiera base viva.** El umbral de 1,000 filas del hallazgo ALTO es
  el `max_rows` documentado por el propio repo (`pg.ts:38-45`,
  `analytics.ts:1728-1731`), no una lectura contra Postgres.
