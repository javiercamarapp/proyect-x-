PARCIAL: 11 de 12 rubros auditados (`pruebas` sin entregar), 1 CRÍTICO arreglado con prueba, 1 ALTO revertido con su razón, global 5.8 → 5.4.

- **Tipo:** ronda **COMPLETA**, decidida antes de gastar un token en auditores:
  `list_pull_requests(open)` → 6 PRs y **ninguno de auditoría** (#326 cerrado y
  mergeado), y `git log a3c1560..origin/master -- src/ supabase/ normas/` →
  **181 commits, 346 archivos, +27,031/−2,631**. Rama nueva
  `claude/auditoria-27` sobre `06b2eca4`.
- **Por qué PARCIAL y no COMPLETA:** el auditor de **pruebas** nunca entregó su
  archivo. Su nota (8) **no se mueve** y queda marcada `no auditado esta ronda`.
  Los otros 11 entregaron.
- **Global: 5.4** (antes **5.8**) · **▼ 0.4**. Suben 2 (seguridad 7→8, datos
  6→7), bajan 6, se quedan 4.
- **La lectura:** nueve de los doce rubros no recibieron un solo commit desde
  que se calificaron y la nota bajó igual. Los 181 commits se concentraron en
  fiscal, póliza, analytics y seguridad —y **eso se nota**: por primera vez en
  cuatro rondas el trabajo de arreglo anterior resistió, con **7 de 7 cierres
  fiscales verificados** contra 1 de 4 en la 26.
- **Arreglado: 1**, en 1 commit atómico con prueba que lo reproduce:
  - `5569437e` — **OP-C2 (CRÍTICO)**: la alarma de producción congelada **se
    cerraba sola en cada push a `master`**. El cotejo de deriva no corre en un
    push, pero el paso que cierra el issue estaba en `success()` a secas.
    Medido contra la API de GitHub: #339 abierto 04:53:03Z por un schedule en
    rojo y cerrado 11:01:53Z por un push, con 20 schedules rojos seguidos y
    **ningún issue abierto** mientras producción lleva 224 commits atrás.
    Rojo→verde medido (`Received: "success()"`).
- **Revertido con razón escrita: 1.** BE-3 (la liquidación rechazada que sigue
  sumando en 4 agregadas). La migración 0348 y su prueba se escribieron y
  midieron rojo→verde, pero la suite completa se puso roja (41 fallos):
  `staging-recovery.mjs:121` fija el inventario de migraciones a `324/'0347'`
  como **enclavamiento de una operación destructiva**. Subirlo de madrugada
  debilita ese candado y se sale del alcance del hallazgo.
- **Hallazgo nuevo que no traía ningún auditor — [ALTO] OP-C4:** por ese mismo
  pin, **el repo no acepta una sola migración nueva sin ponerse rojo** (35
  pruebas caen con `RECOVERY_LOCAL_MIGRATIONS`). Verificado revirtiendo.
- **Dos auditores independientes encontraron el mismo CRÍTICO** (`ingerirRep`
  sin reloj, `intake/rep.ts:190-241`): agéntico y rendimiento, en paralelo y sin
  contacto.
- **Pendientes con razón escrita: 6 críticos y 1 alto**, ninguno quirúrgico. Dos
  exigen una decisión de producto, uno una **mano humana** (aplicar 0304→0347 y
  publicar), uno un servicio externo, y el fiscal exigiría una **sexta**
  implementación del mismo predicado dentro de SQL.
- **Compuerta al cerrar:** `npm test` 12,169 pasan / 5 fallan (las 5 son INFRA:
  `EAFNOSUPPORT ::1`, sin loopback IPv6 en el contenedor) · `tsc --noEmit` exit
  0 · `lint` 0 errores, 156 avisos. La única diferencia con la línea base es la
  prueba nueva del arreglo.
- **Tablero:** `tablero.html` + `tablero.png`, capturado y **mirado** (12
  rubros, notas suman 65, 65/12 = 5.4); se corrigieron dos defectos al verlo.
