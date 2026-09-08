# Auditoría 29 — síntesis

**8-sep-2026** · ronda **COMPLETA**, 12 rubros · rama `claude/auditoria-29` sobre
`7bcc319` · árbol limpio al arrancar, **autofix habilitado**.

**Global: 6.0** (anterior: **4.4**) · **▲ 1.6**. Suben 11, baja 0, se queda 1.

---

## Lo primero, porque es de ahora y no es de esta rama

**Producción está en 503 mientras lees esto**, pero por una causa **distinta** de
la que denunció la 28. Medido contra la API de GitHub, corrida **34212560163**
(`salud-produccion.yml`, schedule, 8-sep 09:54 UTC, `head_sha=7bcc319`):

```
http=503 estado=degraded crons=degraded
migracion={"base":"0347","codigo":"0347","atras":0, …}
desplegado=d56e626 ultimo_[deploy]=d56e626
Producción corre el último [deploy] (d56e626) o uno posterior.
cadencia: declarada=30min real=268min
Ya hay un issue abierto (#365); no se duplica.
```

Tres lecturas, y las tres cambian el tablero:

1. **La deriva de esquema SE CERRÓ.** `base=0347`, `codigo=0347`, `atras=0`, y el
   cotejo confirma que producción corre el último `[deploy]`. Los dos primeros
   CRÍTICOS de la 28 —código viejo contra esquema nuevo, y la firma de
   `gastos_fiscales_agregados_tenant` que la 0317 dropeó— **ya no aplican**. La
   mano humana ocurrió: el issue #344 lo cerró `javiercamarapp` el 7-sep 18:12.
   No se lo acredita este repo.
2. **Sigue en rojo por otra cosa: `crons=degraded`.** El pulso lleva **52
   corridas consecutivas en `failure`** (#513→#564), **14 h 33 min**, con el
   issue **#365** abierto desde el 7-sep 19:20 y `updated_at == created_at`:
   nadie lo ha abierto. **Qué cron concreto cayó no es visible desde aquí** — el
   log dice `degraded` sin decir de quién, y eso es en sí el hallazgo OP-C1.
3. **Los 43 commits de arreglos de la 28 NO están publicados.** Producción corre
   `d56e626`; `master` va en `7bcc319`. Ninguno de los 43 lleva la bandera en el
   asunto — el modo de falla silencioso que documenta `CLAUDE.md`. Entre lo no
   publicado va el propio arreglo de OP-C1 de la ronda 28: el JSON vivo no trae
   la clave `adelante` que `cotejar()` devuelve incondicionalmente desde
   `ddf0131`. **Publicar sigue siendo una mano humana** (Redeploy en Vercel).

Un dato que sí funcionó: el medidor de cadencia de OP-A2 (`861d09d`) **midió y
avisó** — 268 min reales contra los 30 declarados.

---

## Las notas

Global = media aritmética de los 12, con un decimal: **72 / 12 = 6.00 → 6.0**.

| Rubro | Antes | Hoy | Δ | Porqué del movimiento |
|---|---|---|---|---|
| **Sistema agéntico** | 4 | **7** | ▲3 | **Se atacó y subió.** 11 de 12 abiertos cerrados, abiertos uno por uno en el fuente y en su prueba. El CRÍTICO de dos rondas —`ingerirRep` sin reloj— está cerrado de verdad: el corte va antes de arrancar cada docto, los cuatro llamadores pasan `venceEn` real, y `rep.test.ts:244` falla si se revierte (150 doctos → exige 63/87). |
| **Operabilidad y DX** | 3 | **6** | ▲3 | **Se atacó y subió.** 7 de 8 cerrados reproduciendo el escenario, no leyendo asuntos. Y el hallazgo estructural de la ronda: el cuello de `staging-recovery.mjs:121` **quedó abierto** — verificado creando una migración sonda `0348` y corriendo las suites (28 archivos, 452 pasan, 0 fallos). Con él se destraban tres críticos de otros rubros. |
| **Frontend** | 4 | **6** | ▲2 | **Se atacó y subió.** 8 de 10 cerrados, y en los ocho la prueba falla al revertir el arreglo. No pasa de 6 porque el CRÍTICO del Anticipo va en su **4ª ronda** intacto. |
| **Backend y API** | 4 | **6** | ▲2 | **Se atacó y subió.** 5 de 6 cerrados, cada uno con su prueba nombrada y abierta. No sube más porque BE-3 —los seis agregados que suman dinero de liquidaciones rechazadas— sigue **idéntico, tercera ronda**. |
| **Tool calling** | 5 | **7** | ▲2 | **Se atacó y subió.** Primera ronda en cinco que recibe líneas, y las recibió donde dolía: 3 de los 4 ALTOS cerrados con prueba que muere al revertir. La suite del rubro pasó de 53 archivos/321 pruebas —idénticos en la 26, 27 y 28— a 54/339. Siguen 33 tools y **ninguna rompe la regla de `properties: {}`**. |
| **Rendimiento y costo** | 4 | **6** | ▲2 | **Se atacó y subió.** 12 de 13 cerrados. El cierre que vale no es un parche sino una función: `margenUnidadAtomicaMs()` convierte el margen de reloj de un cron en una **derivación** de los techos de su unidad atómica. Le cuesta el 7 un CRÍTICO nuevo en el cron del SAT. |
| **Pruebas** | 6 | **7** | ▲1 | **Se atacó y subió**, y es el único rubro que lo prueba mutando: **44 mutaciones probadas, 35 muertas (80 %)**, contra 5 de 15 en la 28. 11 de 14 abiertos cerrados con mutación que muere. Dictaminó además que las 5 fallas INFRA las cerró `6beb5f5` (PRU-B4) **y no otra cosa**. |
| **Modelo de datos** | 6 | **7** | ▲1 | **Se atacó y subió.** El ALTO que hundió la nota en la 28 se cerró y no de rótulo: `supabase/tests/0344_analytics_sin_rechazadas.sql` añade el caso que hace divergir las dos RPC a propósito. Esquema sin cambios: 324 `.sql` hasta la 0347, tercera ronda seguida. |
| **Cumplimiento legal** | 4 | **5** | ▲1 | **Se atacó y subió**, un punto y no dos. El CRÍTICO de la 28 —toda solicitud ARCO del canal de texto con `operador_id = NULL`— **está cerrado de punta a punta**, recorrido entero y con prueba que afirma el argumento. Pero un CRÍTICO nuevo lo sustituye (LEG-C1) y quedan dos reincidentes intactos. |
| **Cumplimiento fiscal** | 3 | **4** | ▲1 | **Se atacó y subió**, un punto, y la razón de que sea uno está escrita: el CRÍTICO **no se cerró, mutó** — ver abajo. Lo que sí cerró: la puerta del onboarding del cliente, medida (`regimenSat=601` produce `regimenElegible=false`), y 4 de 6 abiertos. Sigue en el tramo «imprime una cifra fiscal equivocada». |
| **Arquitectura** | 3 | **4** | ▲1 | **Se atacó y subió.** 9 de 14 cerrados y es su mejor ventana desde que existe el tablero: la lectura sin cota del motor del dinero ya no existe (`desde_db.ts` pagina con `traerTodo`+`order`+`range`) y los guardias dejaron de medir la unidad equivocada. No sube más porque el CRÍTICO va en su **7ª aparición** y el predicado del 15 % vive en **cinco** implementaciones (3 TS + 2 SQL), que es literalmente el ancla del «≤4». |
| **Seguridad** | 7 | **7** | = | **Dos fuerzas del mismo tamaño, las dos escritas.** *Se atacó y subió*: 4 de 5 abiertos cerrados de verdad, uno verificado **ejecutando** la función real. *Deuda que cobró factura*: el ALTO del interceptor de QA mutó — el escenario que nombró la 28 está cerrado con dos capas, pero la causa raíz que la 28 escribió («estado global mutable del proceso») sobrevivió intacta y hoy falla por otro lado. Y el ancla estructural no se movió un milímetro. `npm audit`: **0 vulnerabilidades sobre 751 dependencias**. |

### La reserva que va con este +1.6

La 28 bajó **diez notas exactamente 1** sobre código que no cambió, y dejó
escrito que la uniformidad era sospechosa. Esta ronda sube once. Hay que decir de
qué está hecho el rebote, porque la simetría invita a desconfiar de las dos:

**A favor de que es real.** La ventana trae **43 commits que son los arreglos de
esos hallazgos**, y el encargo a cada auditor fue explícito: *un commit cuyo
asunto cita tu ID no es evidencia de cierre, es evidencia de intento*. Los doce
dictaminaron abriendo el archivo **y la prueba**, y preguntando si la prueba se
pone roja al revertir el arreglo. `pruebas` lo llevó al extremo correcto y lo
midió mutando: 35 de 44 mutaciones mueren hoy, contra 5 de 15 en la 28. Ese
número es la mejor evidencia de la ronda de que los cierres son cierres.

**En contra.** Parte del rebote es **corrección de la sobre-corrección de la
28**, no mejora del código. Los saltos de **+3** (agéntico, operabilidad) miden
las dos cosas a la vez y **no las puedo separar con lo medido hoy**. Si la 28 se
pasó de castigo —y su propia síntesis admitió que podía—, una parte de este +1.6
es devolver puntos, no ganarlos.

**Lo que aguanta verificación son los cierres, no el tamaño del escalón.** La
serie 6.2 → 5.3 → 6.0 → 5.8 → 5.3 → 4.4 → 6.0 tiene ahora dos saltos grandes en
direcciones opuestas en dos días, y eso es una propiedad del método, no del
código.

---

## Los ocho críticos

**Arreglados en esta ronda (2), cada uno con prueba que lo reproduce:**

- **`166310c` — FIS-C1.** El `<select>` sí/no de `/admin/flotas` le ganaba a la
  clave del SAT. Y el matiz que lo hace el hallazgo más importante de la ronda:
  **el arreglo de FIS-A3 de la auditoría 28 lo empeoró**. Antes, un «Régimen: Sí»
  a mano solo llegaba a `tenant.config` (legado) y **perdía** contra el perfil;
  desde `b877f2f` escribe `tenant.perfil` con `procedencia: 'declarado'` —la
  única que `decidir()` obedece— y le gana a todo, incluida la derivación
  correcta desde la clave. Medido sobre una flota 601 con un CFDI de diésel en
  efectivo de $11,600: de **$0.00 a $11,600.00** deducibles y de **$0.00 a
  $1,600.00** de IVA acreditable, impreso citando la RFA 2026 regla 2.9.
  El arreglo mueve la derivación a `perfil/preguntas.ts` (una fuente, no un
  literal local) y hace que `actualizarFacilidad15` coteje **solo la dirección
  peligrosa**: conceder de más contra una clave que lo niega se rechaza; negar de
  más, o declarar sin clave registrada, pasa. Rojo→verde medido con `git stash`.
- **`d232f83` — LEG-C1.** La ubicación que el chofer comparte por el chat se
  manda por WhatsApp a una grúa o llantera —un tercero que **no es persona
  encargada**, presta su propio servicio—, y el aviso enumeraba una lista cerrada
  de dos (autoridad fiscal y contador) que no lo incluía, rematando con «si algún
  día se quisiera transferir tus datos para algo distinto, se te pedirá permiso
  antes». `grep -i "grúa|llantera|auxilio|taller"` sobre `privacidad.ts` daba
  **cero**. El aviso ahora nombra el flujo, el dato que sale (la ubicación), hacia
  quién, que **sí es una transferencia**, y qué no va en el mensaje (el teléfono
  del operador). Rojo→verde medido: 8 de 9 casos fallan sin el arreglo.

**Propuesto (1):**

- **REN-C1** — el cron del SAT. 256.5 s de `venceEn` + 75.0 s nominales de la
  unidad del `consolidado` = **331.5 s contra `maxDuration = 300`**, y el sello de
  dedup se commitea en `ciclo.ts:297-310` **antes** de llamar a la conciliación en
  `:324`. Un ECC muerto a media conciliación **no se reintenta jamás**: en la
  corrida siguiente el CFDI sale por `cfdisRepetidos` (`:315`) y
  `cfdi_consolidado_linea` queda vacía. ~$27,600 de IVA de un mes de tarjeta de
  combustible que no llegan al contador, sin alerta. **Verificado por mí abriendo
  el orden real.**

  **Y lo llevé un paso más, porque cambia qué clase de problema es.** Buscando el
  arreglo encontré dos cosas:

  1. **El mecanismo del guardarraíl es barato.** `decidirCruce(cfdi, gastos,
     lineasEcc)` (`cruce.ts:90-94`) es **pura** y solo necesita el CFDI parseado y
     el fondo — las dos cosas ya existen **antes** del sello. Así que se puede
     saber que el destino es `consolidado` antes de sellar, y cortar por el mismo
     camino que el archivo ya tiene (`return { completo: false }`, el llamador no
     marca el paquete como bajado, la corrida siguiente lo re-baja y retoma). No
     hace falta «desellar» nada.
  2. **Pero el número no sale, y ahí deja de ser un arreglo.** Si se deriva el
     margen con la disciplina del propio repo —`margenUnidadAtomicaMs`, que suma
     **techos**— la unidad del consolidado (~246 consultas: 46 páginas de
     candidatos + 100 tandas de `ligarLineaAGasto` a 2 cada una) pide **~2,375 s
     contra un `maxDuration` de 300**. Es decir: **bajo la propia regla de margen
     de la casa, un consolidado no cabe NUNCA en este cron.** Un guardarraíl
     honesto no lo protegería: lo dejaría sin correr para siempre, cambiando una
     pérdida silenciosa por un aplazamiento perpetuo.

  **Por eso queda propuesto y no arreglado**, y la decisión que pide no es de una
  línea: la conciliación del consolidado tiene que salir de este cron (job propio
  o cola con reanudación por página), no caber en él. Es exactamente el caso de
  «un crítico que resistió necesita una decisión, no un cuarto intento». Queda con
  su escenario, sus números y este camino escrito para la 30.

**Pendientes con razón escrita (5):**

- **FE-C1** (4ª ronda) — el despacho no ofrece el Anticipo y la pantalla de firma
  presenta el 0 como una medición. **No existe un solo `update` de
  `viaje.anticipo` en todo `src/`**: falta un escritor entero. Es alcance de
  producto, no un arreglo.
- **ARQ-C1** (7ª aparición desde la 24) — un ajuste firmado tira el export
  contable del periodo completo. `git diff c7bbb83..HEAD` sobre `export/poliza/`
  y `revision_recalculo.ts` devuelve **vacío**. Exige rediseño del export.
- **OP-C1** — producción en 503 con un cron caído. No vive en el repo y **qué
  cron cayó no es visible desde aquí**. Mano humana.
- **FIS #2** (4ª ronda) — la copia de un comprobante entra al 15 % por la RPC
  (`0345:27`) y no por el motor. Exige migración — **que esta ronda desbloqueó**,
  así que en la 30 ya es arreglable.
- **PRU-C1** (4ª ronda) — exige `psql` contra Postgres real: no verificable en la
  nube.

---

## Lo que el orquestador verificó a mano

**Seis**, no los 80 — y se dice cuáles, en vez de insinuar cobertura total:
FIS-C1 (las cinco líneas citadas, una por una), LEG-C1 (`grep` contado y los dos
archivos del circuito), REN-C1 (el orden real del sello contra la conciliación),
el estado de producción (corrida y cuerpo del health por la API), el desbloqueo
de migraciones y las 5 fallas INFRA.

**Ningún hallazgo resultó falso esta ronda.** En la 28 uno lo fue, y se dice para
que se note la diferencia.

---

## Compuerta

**Al arrancar** (sobre `7bcc319`): `npm test` **935 archivos, 12,536 pasan, 6
saltadas, 0 fallan**, exit 0 · `tsc --noEmit` exit 0 · `lint` 0 errores, 154
avisos.

**Al cerrar** (con los dos arreglos): `npm test` **937 archivos, 12,553 pasan, 6
saltadas, 0 fallan**, exit 0 · `tsc --noEmit` exit 0 · `lint` 0 errores, 154
avisos · `lint:ratchet` 0 nuevos. Los **+17** son las pruebas de los dos
arreglos.

**Las 5 fallas INFRA de la 27 y la 28 ya no ocurren.** Eran
`listen EAFNOSUPPORT ::1` en `scripts/ci/e2e/proxy-local.test.ts` (el contenedor
de la nube no tiene loopback IPv6). Las cerró `6beb5f5` (PRU-B4) con un
`it.skipIf` selectivo solo en los casos que bindean `::1` — dictaminado midiendo,
no por el asunto del commit. Es la primera ronda en la nube con la compuerta
entera.

`npm run build` **no se corre aquí**: pide Supabase, OpenRouter, Facturapi y
Upstash, y su fallo no diría nada del código.

---

## Tablero

`tablero.html` + `tablero.png`, capturado **y mirado**: 12 rubros contados en la
imagen, las notas suman **72**, 72/12 = 6.0, y los ocho críticos aparecen con su
estado. La primera captura salió truncada a 2,500 px y se repitió a 3,200; en la
revisión también apareció un conteo mal sumado (79 por 80) y se corrigió antes de
commitear. Mirar el render encontró las dos cosas que medir no encontró.
