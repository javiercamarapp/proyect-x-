# MAPA — auditoría 30 (ronda COMPLETA, 12-sep-2026)

## Qué es esta ronda

**Ronda COMPLETA, 12 rubros.** La decisión se tomó con la regla de tamaño,
**antes** de gastar un token en auditores:

- `list_pull_requests(javiercamarapp/cuadra, state=open)` → **1 PR abierto**,
  **#459 `chore(normas): latido cuota-diesel — INFRA, egress bloqueado`**, que
  **no es de auditoría**. El PR de la ronda 29 está mergeado (`8fc2fa7` en el
  log de `master`). → **no aplica la regla de continuación**.
- `git log 7bcc319..HEAD -- src/ supabase/ normas/` → **38 commits**, **116
  archivos**, **+7,345 / −171** → hubo cambios, y muchos → **no aplica la ronda
  ligera**.

Rama nueva: **`claude/auditoria-30`** (prefijo `claude/` obligatorio: las
routines solo pueden pushear a ramas con ese prefijo). Base: `master` =
`4e36c82`. Árbol limpio al arrancar (`git status --porcelain` vacío) →
**autofix habilitado**.

El clon de la nube no traía `node_modules`: se corrió `npm ci` (613 paquetes,
32 s, exit 0) antes de la compuerta. Costo de la ronda, no un fallo.

## La advertencia de esta ventana: es una CAMPAÑA DE COBERTURA, no de producto

Léela antes de empezar, porque decide dónde está el riesgo hoy.

De los 38 commits, **20 son de un solo tipo**: `test: cobertura de N páginas de
/admin (lote 1..8)` y `test(<área>): primera cobertura de /dashboard/<página>`.
Entre ellos suman **~49 archivos de prueba nuevos** y son la mayor parte de las
+7,345 líneas. **El conteo de archivos de prueba pasó de 933 a 982.**

Eso crea un riesgo específico y es la pregunta adversarial central de la ronda:

> **¿Esa cobertura prueba algo, o solo prueba que el componente renderiza?**

Un `page.test.tsx` que monta la página con datos falsos y afirma «se pintó el
título» sube el conteo, sube la sensación de red, y **moriría igual si alguien
rompe la cifra que la página imprime**. La skill lo llama por su nombre:
*decoración*. `pruebas` tiene que medirlo rompiendo a propósito la función que
2–3 de esas pruebas dicen cubrir; `frontend` tiene que decir si las páginas que
ahora tienen prueba de verdad tienen cubiertos sus estados (vacío, cargando,
error, parcial) o solo el camino feliz.

**Y al revés: si la cobertura sí muerde, es el mayor cierre estructural en
varias rondas** — 35 pantallas que no tenían un solo arnés ahora lo tienen. *Se
atacó y subió* sería la razón correcta. **No regales el punto sin medir.**

## Lo segundo: entraron 9 migraciones — el cuello de la 29 quedó abierto de verdad

La 29 dejó como su hallazgo estructural que `staging-recovery.mjs:121` ya no
fija el inventario, y lo verificó con una migración sonda. **Esta ventana lo
confirma con migraciones reales**: `supabase/migrations/` pasó de **324 a 333
`.sql`**, de la **0347 a la 0356**, primera vez en tres rondas que entra esquema
nuevo.

| Migración | Qué dice hacer | A quién le toca |
|---|---|---|
| `0348_analytics_sin_rechazadas_2.sql` | 6 agregados más excluyen liquidaciones rechazadas (BE-A2/DAT-M1) | **backend**, **datos** |
| `0349_combustible_15_sin_copias.sql` | el cubo del 15 % excluye copias del mismo comprobante (FIS-C2/ARQ-A3) | **fiscal**, **arquitectura** |
| `0350_cascade_chat_cobranza.sql` | `chat_conversacion` y `cobranza_contacto` en cascada al borrar tenant (DAT-M2) | **datos**, **legal** |
| `0351_costo_fase_copiloto_runner.sql` | `FaseCosto` admite `copiloto` y `runner` (TC-B2) | **tool calling**, **datos** |
| `0352_factura_retencion_iva.sql` | `factura_emitida` puede representar la retención de IVA (FIS-M3) | **fiscal**, **datos** |
| `0353_revisar_liquidacion_arco_cuerpos_completos.sql` | cuerpos completos literales de `revisar_liquidacion` y `ejecutar_arco_cancelacion` (DAT-M3) | **datos**, **legal** |
| `0354_cierre_insumos_hash_v2.sql` | `cierre_insumos_hash` excluye REP '99' del combustible en efectivo (DAT-B1) | **datos**, **fiscal** |
| `0355_gastos_fiscales_sin_copias.sql` | `gastos_fiscales_agregados_tenant` excluye copias (FIS-A3) | **fiscal** |
| `0356_arco_borra_contacto_emergencia.sql` | la cancelación ARCO también borra el contacto de emergencia (LEG-M5) | **legal**, **datos** |

**Nueve funciones de base reescritas de golpe y ninguna se puede ejecutar aquí**
(no hay Postgres en la nube). Lo que sí se puede hacer, y es obligatorio para
`datos` y `fiscal`: leer el cuerpo SQL nuevo **contra** el `supabase/tests/*.sql`
que lo acompaña y contra el TS que lo llama, y decir si el test SQL contiene el
caso que hace **divergir** la función vieja de la nueva o solo el camino feliz.
Un `CREATE OR REPLACE FUNCTION` que cambia un `WHERE` y un test que no ejercita
ese `WHERE` es exactamente el modo de falla del rubro.

## El resto de los 38 commits

| Sha | Asunto (abreviado) | A quién le toca |
|---|---|---|
| `e2038a5` | REN-C1 escala — `candidatosDb` del consolidado pagina por cursor | **rendimiento**, fiscal, backend |
| `d0db998` | REN-C1 — un consolidado ECC a medio conciliar SÍ se reintenta | **rendimiento**, **fiscal**, agéntico |
| `15fd8d3` | Cal.com sin configurar es `config_ausente`, no fallo | **operabilidad**, backend |
| `94de18f` | `/admin/crons` muestra el detalle real de una corrida parcial | **operabilidad**, frontend |
| `0754652` | `Cache-Control: no-store` en las 7 rutas de export fiscal/financiero | **seguridad**, legal |
| `8fc2fa7` | auditoría 29 — FIS-C1 y LEG-C1 con prueba | **fiscal**, **legal** |
| `31638fd`, `03bd4e8`, `a330613`, `4e36c82` | latidos de `dof-diario` / `vigilancia-normativa`, sin cambio del dominio | fiscal, legal (verificar que de verdad no cambian nada) |
| 5 commits `[deploy] …` | publicación | **operabilidad** |

**REN-C1 era el único *propuesto* de la 29** — el crítico que aquella ronda
verificó y decidió no arreglar porque «toca el camino del dinero y su arreglo no
es quirúrgico». Alguien lo arregló en dos pasos. `rendimiento` y `fiscal` tienen
que dictaminar si el arreglo cerró la causa raíz o movió el problema: el segundo
commit (`e2038a5`, *«escala — pagina por cursor»*) es la huella típica de un
arreglo que destapó un segundo problema en el mismo camino.

## Los pendientes de la 29 — punto de partida obligado

Cada auditor **lee completo `docs/auditoria-29/<su-rubro>.md` antes de empezar**
y dictamina cada hallazgo abierto suyo: **cerrado** (con la prueba que lo ancla)
· **REINCIDENTE** (con el escenario reescrito con los valores de hoy) ·
**mutado** (el síntoma se fue, la causa raíz no).

La 29 cerró 2 críticos con prueba (`166310c` FIS-C1, `d232f83` LEG-C1) y dejó
**80 hallazgos, 8 críticos**, de los cuales **5 pendientes con razón escrita** y
**1 propuesto**. Los reincidentes de larga data que la 29 dejó anotados y que
**pesan más que un hallazgo nuevo** si siguen ahí:

- **FE-C1** — el CRÍTICO del Anticipo, **4ª ronda** intacto («no existe un solo
  `update` de `viaje.anticipo` en `src/`»). → **frontend**
- **BE-3** — los seis agregados que suman dinero de liquidaciones rechazadas,
  **3ª ronda**. Ojo: `0348` dice atacarlo. → **backend**
- **ARQ-C1** — **7ª aparición**; el predicado del 15 % vive en **cinco**
  implementaciones (3 TS + 2 SQL). Ojo: `0349` toca una de ellas — ¿bajó a
  cuatro o subió a seis? → **arquitectura**
- **OP-C1** — `crons=degraded` sin decir **cuál** cron; issue #365. → **operabilidad**
- **PRU-C1** — exige una base viva. → **pruebas**

**Un commit cuyo asunto cita tu ID no es evidencia de cierre, es evidencia de
intento.** Abre el archivo, abre la prueba, y pregunta si la prueba se pondría
roja con el arreglo revertido.

## Notas previas (auditoría 29, global 6.0)

| Rubro | Nota 29 | Razón que la sostuvo |
|---|---|---|
| Frontend | 6 | se atacó y subió; tope por FE-C1 en su 4ª ronda |
| Backend y API | 6 | se atacó y subió; tope por BE-3 en su 3ª ronda |
| Sistema agéntico | 7 | se atacó y subió, +3; el crítico de `ingerirRep` cerró de verdad |
| Tool calling | 7 | se atacó y subió; 33 tools y ninguna rompe `properties: {}` |
| Seguridad | 7 | dos fuerzas iguales; `npm audit` 0/751; ancla estructural sin moverse |
| Cumplimiento fiscal | 4 | subió 1; el crítico **mutó**, no cerró |
| Cumplimiento legal | 5 | subió 1; crítico de la 28 cerrado, LEG-C1 nuevo lo sustituyó |
| Arquitectura | 4 | subió 1; ARQ-C1 en su 7ª aparición, predicado del 15 % en 5 copias |
| Pruebas | 7 | se atacó y subió; **35 de 44 mutaciones mueren** (era 5 de 15) |
| Operabilidad y DX | 6 | se atacó y subió, +3; OP-C1 abierto |
| Rendimiento y costo | 6 | se atacó y subió; le costó el 7 un crítico nuevo (REN-C1) |
| Modelo de datos | 7 | se atacó y subió; esquema sin cambios 3 rondas seguidas |

**La reserva que la 29 dejó escrita, y que aplica a ti hoy:** la 28 bajó diez
notas exactamente 1 sobre código que no cambió; la 29 subió once. La propia 29
anotó que no podía separar «rebote real» de «corrección de la sobre-corrección
de la 28». **Si tu nota de la 29 estaba inflada, esta es la ronda de decirlo con
las palabras exactas: *mirada más profunda — el código no cambió, la nota
anterior estaba inflada*.** Bajar una nota con esa razón escrita es un resultado
válido y esperado.

## Línea base de la compuerta (medida hoy, no recordada)

Corrida sobre `4e36c82` al arrancar la ronda:

```
npx vitest run   → Test Files 984 passed (984)
                   Tests 12931 passed | 6 skipped (12937)   exit 0
npm run typecheck → exit 0
npm run lint      → 154 problems (0 errors, 154 warnings)   exit 0
npm run lint:ratchet → 154/194 heredados; 0 nuevos; 0 errores
```

De la 29, para comparar: `npm test` **937 archivos / 12,553 pasan / 6 saltadas /
0 fallan**, `lint` 0 errores / 154 avisos. → **+47 archivos de prueba, +378
pruebas, 0 fallos, 0 avisos nuevos.** Las 5 fallas INFRA de IPv6 que arrastraban
la 27 y la 28 **siguen sin ocurrir** (segunda ronda limpia).

## Inventario de hoy

- `src/` — **392,307** líneas TS/TSX (eran 386,878 en la 29: **+5,429**).
- **982 archivos de prueba** (`find src scripts -name '*.test.ts*'`; eran 933 →
  **+49**). Mide tú y di cómo mediste.
- `supabase/migrations/` — **333 archivos `.sql`**, hasta la **0356** (eran 324
  hasta la 0347 → **+9**).
- `normas/` — **39 fichas YAML**, sin cambio. Es la **fuente de verdad fiscal y
  legal**; las marcadas `verificado_fuente_primaria` traen el texto literal y
  ganan cualquier discusión.
- `supabase/verificaciones.sql` — batería SQL contra Postgres real (+104/−0 esta
  ventana).

## Dónde está todo

- **`/admin`** — consola de Javier (superadmin). Cruza todos los tenants a
  propósito; `lib/admin/negocio.ts` es la única función con ese permiso.
- **`/dashboard`** — panel del cliente (flota_admin, contador, encargado), ~31
  páginas, todas filtradas al tenant. Reusa los componentes de `/admin`
  (`ui/kit`, `ui/graficas`, `charts`) — no hay una segunda librería de UI.

## Reglas del producto que no se rompen

**Nunca inventar una cifra.** El contralor va a cruzar lo que ve contra su PDF y
su contador. Si no hay dato real: se dice qué falta y por qué
(`dashboard/pendiente.tsx`, `EstadoVacio`). Nunca datos de ejemplo ni ceros que
parezcan medición. Una estimación se muestra declarada y con su supuesto a la
vista (`MINUTOS_CAPTURA_MANUAL` en `lib/likida/analytics.ts`).

**Un rótulo tiene que ser verdad.** Si dice "del periodo", la consulta filtra
por fecha. Si un filtro está en pantalla, mueve TODO lo que hay debajo.

**El formato de cifras vive solo en `lib/formato.ts`.** Hay una prueba que falla
si aparece `toLocaleString('es-MX')` en cualquier otro archivo.

**Fallar cerrado y decirlo.** supabase-js reporta errores POR VALOR: sin
comprobar `error` explícitamente, una base caída se lee como "no hay nada" y el
panel afirma "aún no hay liquidaciones" estando ciego. Ver `exigir()` y
`traerTodo()` en `analytics.ts` — PostgREST recorta a 1,000 filas en silencio.

## Trampas ya pisadas (no volver a caer)

- `gasto.ocr_raw` está MUERTA — `repo.ts` escribe `ocr_confianza`/`ocr_extra`.
  La prueba de que algo pasó por OCR es `ocr_confianza`.
- `politica_gasto` (la tabla) está muerta. La política viva es
  `tenant.config.politica`, vía `getConfig()`.
- `wa_mensaje_procesado` NO tiene `tenant_id`: no se puede atribuir a una flota.
- `viaje.estatus` solo admite `abierto | en_cuadre | liquidado` (constraint
  `viaje_estatus_dominio`). `app_user.rol`: **superadmin, flota_admin, contador,
  encargado, vendedor** (`operador` se retiró en la 0086; `vendedor` en la 0105).
- `cliente`, `unidad`, `tarifa`, `factura_emitida`, `pago_recibido`, `posicion`,
  `cotizacion`, `mantenimiento` y `ticket_mensaje` **YA TIENEN escritor**. Si vas
  a "construir el escritor", ya existe.
- Siguen SIN escritor: `geocerca`, `terminal`, `portal_credencial`,
  `invitacion`, y las muertas de facto `campania`/`envio_mensaje` (las sustituyó
  `campana`, 0123).
- **La base entera está en cero (0 viajes) porque no hay clientes todavía**, no
  porque falte código. Antes de usar cualquier tabla, mira si tiene filas; si no,
  la pantalla dice qué falta.
- `requireSessionTenant(destino)` arma su redirect a /login con un string fijo y
  **pierde el query string** — por eso existe `dashboard/sufijo.ts`.
- **Las tools declaran `properties: {}` a propósito**: el modelo decide *cuándo*,
  nunca *con qué datos*. `tenantId`/`viajeId` salen del contexto del servidor.
  Proponer "validar mejor los argumentos" es no haber leído el código.
- **El push a `master` ya NO despliega solo**: `vercel.json` trae un
  `ignoreCommand` que solo construye si el **asunto** del commit lleva la
  bandera `[deploy]`. El modo de falla es **silencioso**.

## Cómo se verifica AQUÍ (nube, sin credenciales)

La compuerta es **`npm test` + `npx tsc --noEmit` + `npm run lint`**.

**NO se corre `npm run build`**: pide Supabase, OpenRouter, Facturapi y Upstash,
que aquí no existen, y su fallo no dice nada del código.

**NO se corren `pruebas-manuales/*.prueba.ts`**: hacen llamadas reales de pago.

No hay `.env`, ni base, ni red a los proveedores. Cualquier hallazgo que
requiera una base viva se anota como *no verificable en esta ronda*. El PR #459
abierto documenta que **el egress de red está bloqueado** en este entorno: si
intentas salir a internet y falla, es **INFRA**, no un hallazgo.
