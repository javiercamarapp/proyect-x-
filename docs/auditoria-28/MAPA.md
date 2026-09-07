# MAPA — auditoría 28 (ronda COMPLETA, 7-sep-2026)

## Qué es esta ronda

**Ronda COMPLETA, 12 rubros.** La decisión se tomó con la regla de tamaño,
antes de gastar un token en auditores:

- `list_pull_requests(javiercamarapp/cuadra, state=open)` → **14 PRs abiertos**,
  y **ninguno es de auditoría** (#346-#357 son `codeql/lote-*`, #358/#359 son
  dependabot). El PR de la ronda anterior, **#342 `claude/auditoria-27`**, está
  **cerrado y mergeado** (`10dcc26` en el log de `master`). → **no aplica la
  regla de continuación**.
- `git log 06b2eca4..HEAD -- src/ supabase/ normas/` → **3 commits**, **7
  archivos**, **+225 / −75** → sí hubo cambios → **no aplica la ronda ligera**.

Rama nueva: **`claude/auditoria-28`** (prefijo `claude/` obligatorio: las
routines solo pueden pushear a ramas con ese prefijo). Base: `master` =
`d56e626`. Árbol limpio al arrancar (`git status --porcelain` vacío) →
**autofix habilitado**.

El clon de la nube **no traía `node_modules`**: se corrió `npm ci` antes de la
compuerta. Es costo de la ronda, no un fallo (INFRA, resuelta).

## Advertencia de tamaño: la ventana es CHICA y eso cambia el trabajo

La 27 auditó sobre **181 commits** de cambio. Esta ronda tiene **13 commits en
total** y solo **3 tocan `src/`, `supabase/` o `normas/`**, todos en el mismo
sitio: cuatro archivos de `/dashboard`.

**Consecuencia directa para ti:** casi ningún rubro recibió código nuevo. Eso
significa que **la vía honesta para mover tu nota no es buscar regresiones
nuevas — es reabrir tus hallazgos abiertos y decidir si siguen vivos**, y
mirar más hondo donde la nota anterior pudo estar inflada. Si el código de tu
rubro no cambió y tus hallazgos siguen intactos, **la nota se queda igual y lo
dices así**: en la 27, `tool-calling` hizo exactamente eso y fue una entrega
correcta. Inventar movimiento sin una de las tres razones escritas es peor que
no moverla.

## Qué cambió desde la auditoría 27 — commit por commit (son pocos, están todos)

| Sha | Qué es | A quién le toca |
|---|---|---|
| `4de95a0` | **auditoría semanal (#343)** — único commit con código de producto: `dashboard/actividad.tsx` (+15/−?), `inicio-contenido.tsx`, `panel-periodo.tsx`, `rentabilidad/vista.tsx` (+74/−38), más 2 archivos de prueba nuevos (`actividad.test.tsx`, `rentabilidad/vista.test.tsx`, ~98 líneas) | **frontend**, **pruebas** |
| `18c7ebd` / `ebb215c` | **PR #341 `codex/innovativos-sensitive-build`** — `deploy-preview-promote.yml` (+31/−?), `prepare-build-env.mjs` **nuevo** (+110), `prepare-build-env.test.ts` **nuevo** (+111), `deploy-pipeline.test.ts`. Hidrata credenciales verificadas de Supabase para builds sensibles | **operabilidad**, **seguridad** (un script nuevo que **maneja credenciales** y que ningún auditor ha leído todavía) |
| `41aeaae` + `e578dd2` | **PR #338 `dof-diario`** + latido de vigilancia: solo `normas/.latido-vigilancia` (+108/−?). Barrido 03..05-sep **sin hallazgos nuevos** | **fiscal**, **legal** |
| `10dcc26` + `3161317` + `e8a53f7` + `5569437` + … | merge de la propia auditoría 27 y sus docs | — |
| `d56e626` | **`[deploy]` producción al día: migraciones 0304-0347 aplicadas y verificadas.** Es un **commit vacío** (0 archivos): solo lleva la bandera para disparar el build | **operabilidad** — el hallazgo estrella de la 27 era «producción lleva 224 commits congelada». Alguien lo atendió a mano. **Verifícalo, no lo creas por el mensaje del commit** |

**Cómo auditar esto:** para cada hallazgo abierto que te toque, el trabajo
primero es **abrir el archivo y ver si sigue ahí**. Con una ventana de 3
commits, un hallazgo abierto que no fue tocado es REINCIDENTE por construcción
— pero eso **no** lo hace más grave: lo que decide la nota es el daño real, no
la reincidencia contada.

**La advertencia que dejó la 27, literal:** «nueve de los doce rubros no
recibieron un solo commit desde que se calificaron y la nota bajó igual». Si
vas a bajar una nota esta ronda sobre código idéntico, la razón tiene que ser
**mirada más profunda** con evidencia nueva —una medición, un ciclo recorrido,
un archivo que nadie había abierto—, no la repetición de la lista anterior.

## Línea base de la compuerta (medida en esta ronda, no recordada)

Se corrió al arrancar. Ver `docs/auditoria-28/00-SINTESIS.md` para las cifras
exactas con su salida.

De la 27, para comparar: `tsc --noEmit` exit 0 · `lint` 0 errores / 156 avisos
· `npm test` 905 archivos, 12,174 pruebas, 12,168 pasan, 1 saltada, **5 fallan**.

**Las 5 que fallan son INFRA, no código.** Todas en
`scripts/ci/e2e/proxy-local.test.ts`, todas con
`Error: listen EAFNOSUPPORT: address family not supported ::1`. El contenedor
de la nube **no tiene loopback IPv6**; la prueba exige `::1`. No es un defecto
del repo y **no cuenta contra el rubro de pruebas**. Cualquier arreglo de esta
ronda se mide contra esa línea base: 5 fallos infra, ni uno más.

## Inventario de hoy

- `src/` — **377,785 líneas** TS/TSX (eran 377,669), **880 archivos de prueba**
  (medido con `find -name '*.test.ts*'`; la 27 reportó 903 con otro conteo — usa
  el tuyo y di cómo lo mediste).
- `supabase/migrations/` — **324 archivos `.sql`**, hasta la **0347**. **No entró
  ninguna migración nueva** desde la 27.
- `normas/` — **39 fichas YAML**. Es la **fuente de verdad fiscal y legal**; las
  marcadas `verificado_fuente_primaria` traen el texto literal y ganan cualquier
  discusión.
- `supabase/verificaciones.sql` — batería SQL contra Postgres real.

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
- **`staging-recovery.mjs:121` fija el inventario de migraciones a `324/'0347'`**
  como enclavamiento de una operación destructiva. Es la razón por la que la 27
  revirtió su segundo arreglo. Si tu hallazgo exige una migración nueva, **dilo**:
  el repo se pone rojo (35 pruebas) y el arreglo no cabe en esta ronda.

## Cómo se verifica AQUÍ (nube, sin credenciales)

La compuerta es **`npm test` + `npx tsc --noEmit` + `npm run lint`**.

**NO se corre `npm run build`**: pide Supabase, OpenRouter, Facturapi y Upstash,
que aquí no existen, y su fallo no dice nada del código.

**NO se corren `pruebas-manuales/*.prueba.ts`**: hacen llamadas reales de pago.

No hay `.env`, ni base, ni red a los proveedores. Cualquier hallazgo que
requiera una base viva se anota como *no verificable en esta ronda*.
