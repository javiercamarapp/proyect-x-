# MAPA — auditoría 26 (ronda COMPLETA, 4-sep-2026)

## Qué es esta ronda

**Ronda COMPLETA, 12 rubros.** La decisión se tomó con la regla de tamaño,
antes de gastar un token en auditores:

- `list_pull_requests(state=open)` sobre `javiercamarapp/cuadra` devolvió **un
  solo PR: #324 `dof-diario: 2026-09-03`**. No es un PR de auditoría → **no
  aplica la regla de continuación**.
- `git log 4f94490..HEAD -- src/ supabase/ normas/` devolvió **124 commits**,
  **220 archivos**, **+10,428 / −783** → sí hubo cambios, y muchos → **no
  aplica la ronda ligera**.

Rama nueva: **`claude/auditoria-26`** (prefijo `claude/` obligatorio: las
routines solo pueden pushear a ramas con ese prefijo). Base: `master` =
`ce6f462` (merge del PR #322). Árbol limpio al arrancar (`git status
--porcelain` vacío) → **autofix habilitado**.

El clon de la nube **no traía `node_modules`**: se corrió `npm ci` antes de la
compuerta. Es costo de la ronda, no un fallo (INFRA, resuelta).

## Qué cambió desde la auditoría 25 — y es enorme

La 25 cerró con **6 críticos pendientes** y el tope de 3 vueltas agotado.
Después de su PR #319 entró una **«resolución integrada»** (PR #322) de ~110
commits que atacó casi todos esos pendientes. Esto cambia por completo el
trabajo del auditor de esta ronda: **la mayoría de los hallazgos abiertos de la
25 tienen ahora un commit que dice haberlos cerrado, y hay que verificar si de
verdad lo hicieron.**

La lección documentada de la 25 es exactamente esa: la 24 declaró AGEN-1
cerrado, el hallazgo nombraba tres funciones y el arreglo tocó una. **Un cierre
a medias sale más caro que un hallazgo abierto, porque la nota ya cobró la
subida.** Ese es el sesgo a corregir en esta ronda.

Bloques grandes de lo que entró (por rubro):

| Rubro | Commits que dicen cerrarle algo |
|---|---|
| Fiscal | `0e4c0d7` (FIS-C1/C2/ARQ-C1, la proporción del 15 %), `52a4276` (FIS-P1 IVA acreditable), `f37172f` (FIS-P2 nota de crédito), `a8f1acb` (FIS-P3 otro ejercicio), `cccee88` (FIS-P4 retención 4 %), `13a4311` (FIS-P5 LIF 20-A-IV), `de4d642` + `5381d81` + `90108b6` (FIS-REAUD-1/2/3), `a864b9d` (0317 recupera lo que su propio drop+create se llevó) |
| Backend | `d914e74` (BE-C1a/BE-C1b/DATOS-C1: ajustar regenera desglose y versiona PDF), `893e347`, `382365e`, `670a348`, `bcb766b`, `b2cd1a2`, `5b80e6a`, `9ed7e78`, `b609b22`, `62840b3` |
| Seguridad | `c3e52ac` (SEG-3 /api/admin y ?tenant=), `259032d` (válvula del rate limit), `855a46b` (/api/health), `725eae7` + `fa787c0` (revoke), `8544daa` (host del PAC), `d6058df` (SEC-1/RT-1), `822b55d` (SEC-2), `ed64ca9` + `b7d5520` (SEC-3, migr. 0318) |
| Agéntico | `c75320d` (las DOS salidas de correo), `908d69b`, `46b12e2`, `d65c286`, `1c1211d`, `497bc97`, `2879462`, `2f35dfb` |
| Tool calling | `62c44f2` (TC-1, el ORDEN), `497769a` (CAPTURAS entre ciclos), `130e2c7` (tool terminal fallida), `99cc86f` (toolSchemas), `4decc63` + `a86958f` (candado de emisión, incl. `clic`) |
| Legal | `b734426` (LEG-1), `3fde880` (LEG-2 BAJA borra), `0dab70e` (LEG-3 chat del panel), `6ebfa53` (LEG-4), `97c019a` (LEG-5 salud/familia), `6040958` (LEG-6 subencargados), `5c9c1cd` (LEG-OP-1 cámara) |
| Arquitectura | `da8d05e` (?revision=), `74109dd` (estadoRenglon), `b1db6e8` (FIRMA↔TIMBRA), `a0ef2b4` (compuerta por conjunto), `5cbced4` (getUnidades día de México), `f128cd1` (ROL_LABEL/PILL_ESTATUS), `be8d12e` |
| Datos | `af64e5d` (ModelRole), `e9dc576` (DATOS-A2 índice parcial), `7e6a435` (DATOS-M3 FK), `3488b26` (DATOS-M2 bloque 249), `5ff4155` (DATOS-M1), `00b8ab2` (SEG-B1 ve_finanzas), `ef6fe08`, `25bdaef` (DATOS-REAUD-1/2) |
| Rendimiento | `c3d8aa0` (REND-A1 voz por byte), `c3e52ac`→`c3b928e` (REND-A2 PASOS_CIERRE), `8dbc8c9` (REND-A3 ingerir), `06378c4` (REND-A4 LIQUIDACION_USD), `cd0a926` (REND-A5), `4235a1b` (REND-A6), `aa4ac6f` (REND-A7), `1c2a216` (REND-A8), `bb11736` (REND-A9), `cd64938` (CAP-1 techo de IA), `0c11cbf` (CAP-2 traerTodo) |
| Operabilidad | `632f722` (DEPLOY.md backup), `df18af9` (npm run setup), `06f895d` (pdf.no_entregado alerta), `ce70854` (fallo de cliente), `7f0ea11` (APLICAR-EN-PRODUCCION.md) |
| Pruebas | `66a08da` (PRU-ALTO1 bloque 50), `608b45e` (PRU-ALTO2 arnés de firma), `603d688` (PRU-MEDIO póliza), `5e9597c` (PRU-BAJO graduarAgente), `983ddf4`, `490d6b3`, `b4f07c5`, `5cf4a9b`, `0e2c3cd`/`0e3cc2e` (bloques de verificaciones.sql) |
| Frontend | `4b90b08` (región con tokens), `c46bd91` (tile Sin CFDI), `d68ecdd` (pantalla incompleta), `764c6f8` (ROL_BADGE) |

**Migraciones nuevas: de la 0303 a la 0318** (0304 … 0318, con
`NUMERACION-SALTADA.md` documentando saltos). `supabase/verificaciones.sql`
creció +584 líneas.

**Cómo auditar esto:** para cada hallazgo abierto que te toque, el trabajo
primero es **abrir el archivo y ver si el arreglo cubre la pregunta que el
hallazgo hacía, no solo las líneas que enumeraba.** Un cierre parcial se
reporta como REINCIDENTE con la parte que quedó fuera.

## Inventario de hoy

- `src/` — **367,732 líneas** TS/TSX (era 360,158), **846 archivos de prueba**
  (eran 810).
- `supabase/migrations/` — **296 archivos**, hasta la **0318** (eran 281 / 0303).
- `normas/` — **38 fichas YAML** (era 37). Es la **fuente de verdad fiscal y
  legal**; las marcadas `verificado_fuente_primaria` traen el texto literal y
  ganan cualquier discusión.
- `supabase/verificaciones.sql` — batería SQL contra Postgres real, **292
  bloques** (eran 249).

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
  encargado, vendedor** (`operador` se retiró en la 0086; `vendedor` entró en la
  0105).
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

## Cómo se verifica AQUÍ (nube, sin credenciales)

La compuerta es **`npm test` + `npx tsc --noEmit` + `npm run lint`**.

**NO se corre `npm run build`**: pide Supabase, OpenRouter, Facturapi y Upstash,
que aquí no existen, y su fallo no dice nada del código.

**NO se corren `pruebas-manuales/*.prueba.ts`**: hacen llamadas reales de pago.

No hay `.env`, ni base, ni red a los proveedores. Cualquier hallazgo que
requiera una base viva se anota como *no verificable en esta ronda*.
