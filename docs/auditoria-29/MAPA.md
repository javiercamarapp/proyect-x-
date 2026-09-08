# MAPA — auditoría 29 (ronda COMPLETA, 8-sep-2026)

## Qué es esta ronda

**Ronda COMPLETA, 12 rubros.** La decisión se tomó con la regla de tamaño,
**antes** de gastar un token en auditores:

- `list_pull_requests(javiercamarapp/cuadra, state=open)` → **1 PR abierto**,
  **#409 `dof-diario: 2026-09-07`**, que **no es de auditoría**. El PR de la
  ronda 28, **#360**, está **mergeado** (`c7bbb83` en el log). → **no aplica la
  regla de continuación**.
- `git log c7bbb83..HEAD -- src/ supabase/ normas/` → **43 commits**, **228
  archivos**, **+10,376 / −1,399** → hubo cambios, y muchos → **no aplica la
  ronda ligera**.

Rama nueva: **`claude/auditoria-29`** (prefijo `claude/` obligatorio: las
routines solo pueden pushear a ramas con ese prefijo). Base: `master` =
`7bcc319`. Árbol limpio al arrancar (`git status --porcelain` vacío) →
**autofix habilitado**.

El clon de la nube no traía `node_modules`: se corrió `npm ci` antes de la
compuerta (exit 0). Costo de la ronda, no un fallo.

## Advertencia de tamaño: la ventana es ENORME y es toda de arreglos tuyos

Es exactamente lo contrario de la 28. Aquella auditó sobre **3 commits** y le
pidió a los auditores «mirar más hondo» sobre código idéntico; **diez de doce
notas bajaron un punto** y la síntesis anotó esa uniformidad como sospechosa.

Esta ronda audita sobre **43 commits que son, casi sin excepción, los arreglos
de los hallazgos de la 28**. Mira los asuntos: `FE-M1`, `BE-A1`, `AG-A5`,
`TC-M4`, `SEG-M1`, `FIS-A3`, `LEG-A4`, `ARQ-A1`, `PRU-M5`, `OP-M4`, `REN-A1`,
`DAT-M2`. Alguien caminó el tablero de la 28 casi entero.

**Consecuencia directa para ti, y es el trabajo principal de esta ronda:**

1. **Abre cada hallazgo abierto que te tocó en la 28 y decide si el arreglo
   realmente lo cerró.** Un commit cuyo asunto cita tu ID **no es evidencia de
   que el hallazgo esté cerrado**: es evidencia de que alguien lo intentó. Abre
   el archivo, abre la prueba, y pregunta si la prueba fallaría de verdad con el
   arreglo revertido. Un arreglo que cierra el síntoma y deja la causa raíz es
   un hallazgo nuevo, no un cierre.
2. **Busca las regresiones que meten 10,376 líneas nuevas.** Ese es el otro
   modo de falla dominante de esta ventana: en la 28, el único commit de
   producto (`4de95a0`) **destapó una regresión** que se imprimía como
   «Facturas 0–9,800 de 350». Con 228 archivos tocados, el volumen de
   superficie nueva es ~70× mayor.
3. **Si algo se cerró de verdad, dilo y súbele la nota.** *Se atacó y subió* es
   una de las tres razones válidas y esta es la ronda donde más debería
   aplicar. **Que una nota suba es un resultado esperado aquí** — la 28 bajó
   diez notas y dejó escrito que si la 29 encuentra que se pasó de castigo,
   **subirlas con la razón escrita es el resultado correcto**.

**Pero no regales puntos.** El criterio no es «hubo commits en mi rubro», es
«el hallazgo ya no se puede reproducir leyendo el código». Si abres el archivo
y el escenario de falla de la 28 todavía se escribe con los mismos valores, es
**REINCIDENTE** aunque el asunto del commit diga que lo arregló, y eso pesa
**más** que un hallazgo nuevo: significa que el tablero mintió.

## Qué cambió desde la auditoría 28 — los 43 commits, por rubro

Todos son `c7bbb83..HEAD`. Los IDs entre paréntesis son los hallazgos de la 28
que el asunto dice cerrar; **verifícalos, no los creas**.

| Sha | Asunto (abreviado) | A quién le toca |
|---|---|---|
| `9aefea0` | onboarding deriva `regimenElegible` de la clave SAT, no de un sí/no | **fiscal** (era su CRÍTICO) |
| `8e22bc6` | consulta del chofer excluye copias del mismo comprobante | backend, agéntico |
| `16feedf` | `ingerirRep` se corta antes de un docto nuevo, no a la mitad | **agéntico** (era su CRÍTICO), fiscal |
| `59ab4e2` | aísla el interceptor de QA con `AsyncLocalStorage` (SEG-A1) | **seguridad** |
| `ebe1372` | cotizador usa tokens del tema, no colores fijos de Tailwind | frontend |
| `b6920a5` | ARCO por texto resuelve el operador real, no `null` fijo | **legal** (era su CRÍTICO) |
| `a466f9e` | sanea metacaracteres de `.or()` y redacta correos en logs (SEG-M1/M2) | **seguridad** |
| `3670756` | el arnés de QA manda `timestampMs` en cada `processInbound` | pruebas, agéntico |
| `23aa775` | copiloto-admin aísla propuestas, valida objetivo apagado (L18) | agéntico, tool calling |
| `662518b` | relojes de escalamiento y sellos por canal (AG-A3/A4, REN-M4) | agéntico, rendimiento |
| `9d7892a` | analista usa el carril `interactivo` de presupuesto | rendimiento |
| `dd78135` | un solo `LlmBudget` por sesión del piloto de visión (L16) | rendimiento, tool calling |
| `cb6334c` | `generateResponse` detecta truncamiento; loop-guard y costo por modelo | **tool calling** |
| `03feb95` | la liquidación rechazada ya no se sirve como vigente (BE-A1/M1, FE-M2) | **backend**, frontend |
| `c65a01f` | rótulos honestos de «dinero observado» (dos RPC distintas) | frontend |
| `9fd8520` | relojes de conectores y peajes (REN-M2/M3, REN-A4) | rendimiento |
| `388b5d4` | pagina `lineasEccParaCuadre`, guardias de reloj/consulta (ARQ-A1/A2/M1) | **arquitectura**, fiscal |
| `b877f2f` | fuente única para la facilidad 15% en efectivo (FIS-A3) | **fiscal**, arquitectura |
| `904d41f` | mockear `facilidad15Vigente` en `desde_db_ecc_paginacion.test.ts` | pruebas |
| `a4e0719` | el cierre recuperado narra el snapshot archivado (TC-A1/TC-M1) | **tool calling**, agéntico |
| `0071f06` | rótulos de valor, SLA al abrir, claim atómico (ARQ-A5/AG-M1/BE-B1) | arquitectura, backend |
| `897cb65` | foco visible en la firma y flechas de 24px (FE-M3/M5/B3) | **frontend** |
| `077ed02` | escalado y `cola_atorada` cierran su incidente (AG-A5/M3/B3) | **agéntico** |
| `b8142d0` | margen de reloj de gps y descarga-sat derivado de sus techos (REN-A4/A5) | rendimiento |
| `29354d0` | vacío de consulta vs. vacío de negocio en despacho (FE-M1/B1) | **frontend** |
| `4c75dd9` | pruebas positivas que matan mutaciones vivas (PRU-M1/M2/M3) | **pruebas** |
| `0688735` | cotización de grúa al que autorizó, respuesta muda veraz (AG-A4/M2) | agéntico |
| `bb8a0de` | quitar el mensaje crudo de PostgREST del panel de rastreo (FE-M4) | frontend, seguridad |
| `6beb5f5` | inventario de rutas completo, IPv6 selectivo en CI (SEG-B1/PRU-B4/A3) | seguridad, **pruebas**, operabilidad |
| `d1cd337` | parte sin lesionados por construcción, BAJA que sí borra (LEG-A5/M3) | **legal** |
| `dceb00d` | candados con prueba, primer archivo para `sat_descarga/escritura` | **pruebas** |
| `f140b0f` | guardia, runner y candado de emisión (TC-M4/B3/B4) | **tool calling** |
| `a2246c3` | destino interno único, Cal.com sin `import()` de ruta (ARQ-M3/B1) | **arquitectura** |
| `e705d56` | cierre sin techo de reentrega, costo real del corte de ráfaga (AG-A1/B1) | agéntico, rendimiento |
| `910b755` | aviso y ARCO veraces (LEG-A2/A3/A6/M4/B1) | **legal** |
| `70821b2` | baseline de `limite-sin-orden` desalineado (189 vs 188) | pruebas, operabilidad |
| `24a99e2` | `limpiarTenant` borra en orden seguro y ve las 2 tablas (DAT-M2) | **datos** |
| `861d09d` | runbook honesto y verificador por conjunto (OP-M4/M5/A2) | **operabilidad** |
| `99fba32` | fichas honestas y vigencia (FIS-M1/M2, FIS-B1/B2, ARQ-A4) | **fiscal** |
| `7292f9d` | panel de fuente única (ARQ-B2/B4/B5, DAT-B2, FE-B2) | arquitectura, datos, frontend |
| `553a767` | carta muerta avisada, «listo» sin hora ya no se aplaza (BE-A3/A4) | **backend** |
| `2c63d74` + `a2c1653` | techo de IA: rótulo del piso y «OCR caído» falso (REN-A1/A2/B1) | **rendimiento** |
| `42bfa2b` | la firma del aviso de privacidad ahora ve el integral (LEG-A4) | **legal** |
| `7bcc319` | trinquete de cobertura reanclado a medición real (PRU-M4) | **pruebas** |

Los archivos con más superficie nueva, por si tu rubro los toca:
`src/lib/likida/processor.ts` **(+469/−82)**, `src/lib/admin/qa-motor.test.ts`
(+385), `src/lib/likida/processor_cierre_recuperado_snapshot.test.ts` (+258,
nuevo), `src/lib/likida/sat_descarga/escritura.test.ts` (+250, nuevo),
`src/lib/admin/calcom_webhook.ts` (+242, nuevo), `src/app/api/webhook/calcom/route.ts`
(**+6/−219**, se vació hacia el archivo anterior), `src/lib/likida/repo.ts`
(+109/−6), `src/lib/llm/openrouter.ts` (+101/−34), `src/lib/likida/privacidad.ts`
(+89/−10), `src/lib/likida/intake/ocr.ts` (+89/−23).

## Los CRÍTICOS que la 28 dejó pendientes (9) — punto de partida obligado

La 28 cerró 2 con prueba (`ddf0131` OP-C1, `a28c7bb` FE-2) y dejó **9 críticos
pendientes con razón escrita**. Varios de los 43 commits dicen atacarlos. **El
primer trabajo de cada auditor es abrir el suyo y dictaminar: cerrado (con la
prueba que lo ancla) · REINCIDENTE (con el escenario reescrito hoy) · mutado
(el síntoma se fue, la causa raíz no).** Están en
`docs/auditoria-28/<tu-rubro>.md`, que **debes leer completo antes de empezar**.

Tres de ellos morían en el mismo cuello de botella y hay que revisarlo primero:
**`staging-recovery.mjs:121` fijaba el inventario a `324/'0347'`**, así que el
repo se ponía rojo ante cualquier migración nueva. El commit `861d09d`
(«verificador por conjunto») dice haberlo cambiado. **Si de verdad quedó
abierto el paso a migraciones nuevas, eso desbloquea tres críticos de golpe y
es el hallazgo más valioso que puedes traer.** Verifícalo abriendo el archivo.

## Estado de producción — no es del repo pero manda sobre la severidad

La 28 documentó, medido: **producción corría `4f94490` (3-sep) contra el
esquema `0347`**, porque `d56e626` fue un commit vacío que aplicó migraciones
sin publicar código, y la migración **0317 dropeó la firma** de
`gastos_fiscales_agregados_tenant` que el build vivo llamaba. El issue **#344**
quedó abierto. **Publicar exigía una mano humana** (Redeploy en Vercel).

Han pasado 43 commits desde entonces. **Nadie ha verificado si esa mano ocurrió.**
`operabilidad` tiene que dictaminarlo con evidencia (corridas de
`salud-produccion.yml`, estado de #344), no asumirlo en ninguna dirección.

## Línea base de la compuerta (medida en esta ronda, no recordada)

Se corrió al arrancar sobre `7bcc319`. Las cifras exactas con su salida van en
`docs/auditoria-29/00-SINTESIS.md`.

De la 28, para comparar: `tsc --noEmit` exit 0 · `lint` 0 errores / 156 avisos ·
`npm test` **12,191 pasan / 5 fallan / 1 saltada**.

**Las 5 que fallaban eran INFRA, no código:** todas en
`scripts/ci/e2e/proxy-local.test.ts` con `listen EAFNOSUPPORT ::1` — el
contenedor de la nube no tiene loopback IPv6. **Ojo:** el commit `6beb5f5`
(«IPv6 selectivo en CI», PRU-B4) dice haber atacado eso. Si esas 5 ya no
fallan, es un cierre acreditable a `pruebas`/`operabilidad`; si fallan igual,
no cuenta contra ningún rubro pero el arreglo no funcionó y eso sí es hallazgo.

## Inventario de hoy

- `src/` — **386,878 líneas** TS/TSX (eran 377,785 en la 28: **+9,093**).
- **933 archivos de prueba** (`find src scripts -name '*.test.ts*'`; eran 880
  con el mismo conteo → **+53 archivos de prueba**). Mide tú y di cómo mediste.
- `supabase/migrations/` — **324 archivos `.sql`**, hasta la **0347**. **No entró
  ninguna migración nueva** desde la 27. Dos rondas seguidas sin esquema nuevo.
- `normas/` — **39 fichas YAML**. Es la **fuente de verdad fiscal y legal**; las
  marcadas `verificado_fuente_primaria` traen el texto literal y ganan cualquier
  discusión.
- `supabase/verificaciones.sql` — batería SQL contra Postgres real (+29/−5 esta
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
requiera una base viva se anota como *no verificable en esta ronda*.
