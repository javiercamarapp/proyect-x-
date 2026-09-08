COMPLETA: los 12 rubros auditados, 2 arreglos retenidos con prueba, 0 revertidos, global 4.4 → 6.0.

- **Tipo:** ronda **COMPLETA**, decidida antes de gastar un token en auditores:
  `list_pull_requests(open)` → **1 PR abierto y ninguno de auditoría** (#409
  `dof-diario`; el de la 28, **#360**, está mergeado como `c7bbb83`), y
  `git log c7bbb83..HEAD -- src/ supabase/ normas/` → **43 commits, 228
  archivos, +10,376/−1,399**. Rama nueva `claude/auditoria-29` sobre `7bcc319`.
  Árbol limpio → autofix habilitado.
- **Los 12 entregaron.** La ventana es casi enteramente **los arreglos de los
  hallazgos de la 28**, así que el trabajo principal no fue buscar bugs nuevos
  sino dictaminar, hallazgo por hallazgo, si el arreglo cerró la causa raíz o
  solo el síntoma — abriendo el archivo **y la prueba**, no el asunto del commit.
- **Global: 6.0** (antes **4.4**) · **▲ 1.6**. Suben 11, baja 0, se queda 1.
- **La reserva que va con esa cifra:** la 28 bajó diez notas exactamente 1 y
  anotó esa uniformidad como sospechosa; esta sube once. Parte del rebote es real
  —43 commits de arreglos, y `pruebas` lo midió mutando: **35 de 44 mutaciones
  mueren hoy contra 5 de 15 en la 28**— y parte es **corrección de la
  sobre-corrección de la 28**, que no puedo separar con lo medido hoy. Los saltos
  de +3 (agéntico, operabilidad) miden las dos cosas juntas. Queda escrito.
- **80 hallazgos · 8 críticos.**
- **Arreglado: 2**, en 2 commits atómicos, cada uno con prueba que lo reproduce y
  rojo→verde verificado con `git stash` del arreglo:
  - `166310c` — **FIS-C1 (CRÍTICO)**: el `<select>` sí/no de `/admin/flotas` le
    ganaba a la clave del SAT, y **el arreglo de FIS-A3 de la 28 lo empeoró**
    (ascendió el override manual de `tenant.config` a `tenant.perfil`, la fuente
    que decide). Medido: de $0.00 a $11,600.00 deducibles y de $0.00 a $1,600.00
    de IVA acreditable sobre un CFDI de diésel en efectivo, impreso citando la
    RFA 2.9. 3 de 8 casos fallan sin el arreglo.
  - `d232f83` — **LEG-C1 (CRÍTICO)**: la ubicación del operador se transfiere a
    una grúa/llantera —tercero que no es encargado— y el aviso enumeraba una
    lista cerrada de dos que no lo incluía. 8 de 9 casos fallan sin el arreglo.
- **Revertido: 0.** Queda **1 vuelta de 3 sin gastar**: no se gastó porque el
  crítico más tratable que quedaba (REN-C1) toca el camino del dinero y su
  arreglo no es quirúrgico, no por falta de presupuesto.
- **Propuesto: 1** (REN-C1, verificado por el orquestador, con su escenario y sus
  números). **Pendientes con razón escrita: 5** — dos exigen alcance de producto
  (FE-C1, 4ª ronda, no existe un solo `update` de `viaje.anticipo` en `src/`),
  uno rediseño (ARQ-C1, 7ª aparición), uno una mano humana (OP-C1), uno una base
  viva (PRU-C1).
- **El hallazgo estructural de la ronda, y es bueno:** el cuello de
  `staging-recovery.mjs:121` que fijaba el inventario a `324/'0347'` **quedó
  abierto**. No se creyó al diff: se verificó **creando una migración sonda
  `0348` y corriendo las suites** (28 archivos, 452 pasan, 0 fallos), y por
  separado lo confirmó el rubro de datos. Con eso se destraban los tres críticos
  que morían ahí — entre ellos FIS #2, que en la 30 ya es arreglable.
- **Producción, medido y no inferido:** la deriva de esquema de la 28 **se
  cerró** (`base=0347=codigo`, `atras=0`, producción corre el último `[deploy]`),
  pero el pulso sigue **en 503 con `crons=degraded`**: 52 corridas consecutivas
  en rojo, 14 h 33 min, issue **#365** abierto sin que nadie lo toque. Y **los 43
  commits de arreglos de la 28 no están publicados** — ninguno lleva la bandera
  en el asunto. Publicar sigue siendo una mano humana.
- **Compuerta al cerrar:** `npm test` **937 archivos / 12,553 pasan / 6 saltadas
  / 0 fallan**, exit 0 · `tsc --noEmit` exit 0 · `lint` 0 errores, 154 avisos ·
  `lint:ratchet` 0 nuevos. **Primera ronda en la nube con la compuerta entera**:
  las 5 fallas INFRA de IPv6 que la 27 y la 28 arrastraban ya no ocurren, y se
  acreditaron a `6beb5f5` midiendo, no por el asunto del commit.
- **Tablero:** `tablero.html` + `tablero.png`, capturado **y mirado** — 12 rubros
  contados en la imagen, notas suman 72, 72/12 = 6.0. Mirarlo encontró dos cosas
  que medir no encontró: la captura salía truncada y un conteo mal sumado.
- **Verificación:** el orquestador abrió y confirmó **6** hallazgos a mano, no
  los 80, y la síntesis dice cuáles. **Ninguno resultó falso esta ronda.**
