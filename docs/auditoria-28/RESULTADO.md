COMPLETA: los 12 rubros auditados, 2 arreglos retenidos con prueba, 0 revertidos, global 5.3 → 4.4.

- **Tipo:** ronda **COMPLETA**, decidida antes de gastar un token en auditores:
  `list_pull_requests(open)` → **14 PRs y ninguno de auditoría** (#346-#357 son
  `codeql/lote-*`, #358/#359 dependabot; el de la 27, **#342**, está mergeado
  en `master` como `10dcc26`), y `git log 06b2eca4..HEAD -- src/ supabase/
  normas/` → **3 commits, 7 archivos, +225/−75**. Rama nueva
  `claude/auditoria-28` sobre `d56e626`. Árbol limpio → autofix habilitado.
- **Los 12 entregaron**, todos a tiempo — incluido `pruebas`, que en la 27 llegó
  46 minutos tarde y perdió su vuelta de arreglo.
- **Global: 4.4** (antes **5.3**) · **▼ 0.9**. Suben 0, bajan 10, se quedan 2.
- **La reserva que va con esa cifra:** diez de doce bajaron **exactamente 1**,
  casi todos por *mirada más profunda* sobre código que no cambió. Puede ser
  corrección real de notas infladas —hay evidencia nueva en varios rubros— o el
  sesgo del encargo, que les señaló esa vía. **La uniformidad es sospechosa y
  queda escrita como tal en la síntesis**, en vez de vender el 4.4 como medición
  limpia.
- **Lo urgente no es de esta rama: producción está rota ahora.** `d56e626`
  («producción al día») es un **commit vacío**: aplicó las migraciones 0304-0347
  y **Vercel no publicó el código**. Producción corre `4f94490` (3-sep, 231
  commits atrás) contra el esquema `0347`, y la **0317 dropeó la firma** de
  `gastos_fiscales_agregados_tenant` que ese build llama. Verificado por mí:
  el `DROP` en `0317:43`, y la corrida **34111978075** de `salud-produccion` en
  rojo con el issue **#344** abierto. **Publicar es una mano humana** (Redeploy
  en Vercel). Se avisó al dueño por push a media ronda, no al cierre.
- **Arreglado: 2**, en 2 commits atómicos, cada uno con prueba que lo reproduce:
  - `ddf0131` — **OP-C1 (CRÍTICO)**: la deriva **inversa** (esquema aplicado,
    código sin publicar) se reportaba con los valores exactos de «al día»
    —`atras: 0`, sin motivo, `status: ok`, HTTP 200— porque `cotejar()` clampaba
    con `Math.max(0, codigo − base)`. Rojo→verde medido. Es la mitad del
    incidente de producción que **sí** vive en el repo.
  - `a28c7bb` — **FE-2 (ALTO)**: regresión de `4de95a0`, el único commit de
    producto de la ventana. `hasta = (99−1)·100 + 0` imprimía **«Facturas
    0–9,800 de 350»**. El comentario de `vista.tsx:40-42` ya decía lo correcto;
    el código no lo hacía. Rojo→verde medido.
- **Revertido: 0.** Queda **1 vuelta de 3 sin gastar**: no se gastó porque
  ninguno de los 9 CRÍTICOS restantes era quirúrgico, no por falta de
  presupuesto.
- **Pendientes con razón escrita: 9 críticos.** Tres exigen decisión de producto,
  uno una mano humana, uno un servicio externo, uno un rediseño de ciclo, y
  **tres mueren en el mismo cuello de botella**: `staging-recovery.mjs:121`
  (OP-C4) fija el inventario a `324/'0347'`, así que **el repo no acepta una
  migración nueva sin ponerse rojo**. Es el hallazgo estructural de la ronda.
- **Un cierre de la 27 verificado y acreditado:** OP-C2 (`5569437`) **aguantó** —
  el issue #344 sobrevivió tres corridas por push en verde del 7-sep. Un arreglo
  no se acredita su propia nota; éste se la ganó.
- **Compuerta al cerrar:** `npm test` **12,191 pasan / 5 fallan / 1 saltada**
  (las 5 son INFRA: `EAFNOSUPPORT ::1`, sin loopback IPv6 en el contenedor) ·
  `tsc --noEmit` exit 0 · `lint` 0 errores, 156 avisos. Única diferencia con la
  línea base: las **+4 pruebas** de los dos arreglos.
- **Tablero:** `tablero.html` + `tablero.png`, capturado **y mirado** (12 rubros
  contados en la imagen, notas suman **53**, 53/12 = 4.4, y los conteos por
  severidad de las tarjetas suman los 130 declarados).
- **Verificación:** el orquestador abrió y confirmó **7** hallazgos a mano, no
  los 130 — y la síntesis dice cuáles, en vez de insinuar cobertura total.
