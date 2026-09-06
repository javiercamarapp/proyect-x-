# MAPA — auditoría 27 (ronda COMPLETA, 6-sep-2026)

## Qué es esta ronda

**Ronda COMPLETA, 12 rubros.** La decisión se tomó con la regla de tamaño,
antes de gastar un token en auditores:

- `list_pull_requests(javiercamarapp/cuadra, state=open)` → **6 PRs abiertos**,
  y **ninguno es de auditoría** (#338/#329/#324 `dof-diario`, #330/#327
  `normativa`, #328 `cuota-diesel`). El PR de la ronda anterior, **#326
  `claude/auditoria-26`**, está **cerrado y mergeado** (`merged_at`
  2026-09-05T23:08:25Z; `git merge-base --is-ancestor a3c1560 origin/master` →
  SI). → **no aplica la regla de continuación**.
- `git log a3c1560..origin/master -- src/ supabase/ normas/` → **181 commits**,
  **346 archivos**, **+27,031 / −2,631** → sí hubo cambios, y muchos → **no
  aplica la ronda ligera**.

Rama nueva: **`claude/auditoria-27`** (prefijo `claude/` obligatorio: las
routines solo pueden pushear a ramas con ese prefijo). Base: `origin/master` =
`06b2eca4`. Árbol limpio al arrancar (`git status --porcelain` vacío) →
**autofix habilitado**.

El clon de la nube **no traía `node_modules`**: se corrió `npm ci` (612
paquetes, 43 s) antes de la compuerta. Es costo de la ronda, no un fallo
(INFRA, resuelta).

## Línea base de la compuerta (medida, no recordada)

- `npx tsc --noEmit -p .` → **exit 0**, limpio.
- `npm run lint` → **0 errores, 156 avisos**.
- `npm test` (`vitest run`) → **905 archivos, 12,174 pruebas: 12,168 pasan, 1
  saltada, 5 fallan**.

**Las 5 que fallan son INFRA, no código.** Todas en
`scripts/ci/e2e/proxy-local.test.ts`, todas con
`Error: listen EAFNOSUPPORT: address family not supported ::1`. Comprobado
directo en este contenedor:

```
node -e "...s.listen(0,'::1',...)" → IPv6 FALLA: EAFNOSUPPORT
```

El contenedor de la nube **no tiene loopback IPv6**; la prueba exige `::1`. No
es un defecto del repo y **no cuenta contra el rubro de pruebas**. Cualquier
arreglo de esta ronda se mide contra esta línea base: 5 fallos infra, ni uno
más.

## Qué cambió desde la auditoría 26 — y otra vez es enorme

**181 commits, 346 archivos, +27,031 / −2,631**, con **46 merges** y **41
commits tocando `supabase/migrations/`**. Migraciones **de la 0319 a la 0347**
(eran hasta la 0318).

Bloques visibles en el log, por tema (los títulos son del commit, no
verificados):

| Tema | Commits que dicen cerrar algo |
|---|---|
| Fiscal | `6cbac00f` (excluir REP «por definir» del numerador de combustible), `f85e68f3` (fundamento de pago en efectivo), `42f93f91` (exigir revisión y desglose comprobable para exportar póliza), `80692404` (notas de crédito sin conciliar como gastos) |
| Póliza / PDF | `eeb7709d` (publicar pares inmutables y recuperar ajustes firmados), `7923a167` (contrato de exportación SQL), `8f1b1d30` (describir recálculo de ajuste firmado) |
| Analytics | `0c2133a8` (excluir importes rechazados sin perder historial), `b1758730` + `01473844` (actividad reciente por timestamp y desempate determinista) |
| Revisión / cierre | `806d04fe` (distinguir originales de copias duplicadas), `071b0a07` (rechazar liquidación histórica como evidencia de un cierre nuevo) |
| WhatsApp | `fd3e32fe` (conservar orden de conversación cuando falla el claim del inbox) |
| Seguridad / privacidad | `ec88509c` (redactar datos sensibles antes de loggear), `be94db90` (alcance real de cancelación ARCO), `330e8404` + `3b6db537` (validar destino de conectores al abrir TLS), `c8d9821e` (interceptar Meta por host exacto), `a5cbf435` (filtros de exportación sin activar setters de prototipo) |
| Deploy | `6379f0b9` (validar staging y promover candidato Production probado) |

**Cómo auditar esto:** para cada hallazgo abierto que te toque, el trabajo
primero es **abrir el archivo y ver si el arreglo cubre la pregunta que el
hallazgo hacía, no solo las líneas que enumeraba.** Un cierre parcial se
reporta como REINCIDENTE con la parte que quedó fuera.

**Y la advertencia que dejó escrita la 26 para ti, literal:** «de los cuatro
arreglos que la 26 dio por cerrados, la reauditoría salvó uno. Un arreglo no se
acredita su propia nota.» Los tres arreglos de la continuación
(`2a58e075` FIS-C2c, `fc98bbf6` FE-1b, `8c72f7bd` FIS-A3) **aterrizaron después
de que los auditores de la 26 calificaran**: nadie los ha auditado todavía.
Verificarlos es trabajo de esta ronda.

## Inventario de hoy

- `src/` — **377,669 líneas** TS/TSX (eran 367,732), **903 archivos de prueba**
  (eran 846).
- `supabase/migrations/` — **324 archivos**, hasta la **0347** (eran 296 / 0318).
- `normas/` — **39 fichas YAML** (eran 38). Es la **fuente de verdad fiscal y
  legal**; las marcadas `verificado_fuente_primaria` traen el texto literal y
  ganan cualquier discusión.
- `supabase/verificaciones.sql` — batería SQL contra Postgres real, **308
  bloques** (eran 292).

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
