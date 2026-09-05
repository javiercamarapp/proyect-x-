CONTINUACIÓN sobre el PR #326: 3 rubros relanzados (frontend, backend, fiscal), 1 CRÍTICO y 2 ALTOS arreglados con prueba, global 6.0 → 5.8.

- **Tipo:** ronda de **CONTINUACIÓN**, decidida antes de gastar un token en
  auditores: `list_pull_requests(open)` devolvió **#326 `claude/auditoria-26`**,
  de auditoría y vivo. No se abrió ronda 27 ni PR nuevo; se continuó sobre la
  misma rama.
- **Alcance:** los 12 archivos de rubro existían, así que se relanzaron **solo
  los 3** cuyo código cambió después de que se escribió su reporte. Los otros
  nueve conservan su nota, marcados `no auditado esta ronda`.
- **Global: 5.8** (anterior **6.0**) · **▼ 0.2**. Los tres relanzados bajan uno
  cada uno; ninguno porque el código empeorara.
- **La lectura:** de los cuatro arreglos que la ronda 26 dio por cerrados, la
  reauditoría **salvó uno**. `273ecd9` (FE-4) está cerrado de verdad; `75ec862`
  llegó al camino de respaldo; `8abb596` destapó un tercer defecto en la misma
  línea. Es la tercera vuelta consecutiva sobre el cálculo del 15 %.
- **Frontend y backend encontraron el mismo defecto por separado**, en paralelo
  y sin contacto, con encargos distintos.
- **Arreglados: 3**, en 3 commits atómicos, cada uno con prueba que lo reproduce
  y suite verde:
  - `2a58e075` — **FIS-C2c (CRÍTICO)**: el gasto sin fecha entraba al numerador
    del 15 % y no al denominador. El PDF imprimía «no deducible $111,000» donde
    la regla da $93,600, con una razón de 26.1 % que no se puede reconstruir con
    el total del propio renglón. Rojo→verde medido.
  - `fc98bbf6` — **FE-1b (ALTO)**: el arreglo de FE-1 llegó al camino de
    respaldo; el que corre tiraba `pagadoEn` en su mapeo.
  - `8c72f7bd` — **FIS-A3 (ALTO)**: el cuarto sitio medía el cubo del 15 % sin
    las claves del SAT; el agente contestaba «holgado» sobre la liquidación cuyo
    PDF quita deducción.
- **Presupuesto: 3 vueltas contra un tope de 3.** Se paró en el tope.
- **Una decisión que se declara en vez de enterrarse:** FIS-C2c puso 3 pruebas
  en rojo. No se revirtió, tras comprobar que fallaban por **fixture
  incompleto** (sin `fecha` ni `anioEjercicio`, una entrada que producción no
  puede producir) y no por su aserción. Se completó la entrada; **ninguna
  aserción cambió**: 16 inserciones, 1 borrado, cero `expect` tocados.
- **Un hallazgo descartado por falso**, y lo descartó el propio auditor fiscal:
  el BAJO del `monto ≤ 0` de la reauditoría anterior es inalcanzable por el
  CHECK `gasto_monto_no_negativo`.
- **Pendientes con razón escrita:** 1 CRÍTICO (la póliza tras `ajustar`, 4ª
  aparición, exige decidir una convención de producto) y 5 ALTOS, ninguno
  quirúrgico. Uno de ellos —el REP con `FormaDePagoP='99'`— exigiría **voltear
  una aserción existente**, y eso no se hace de madrugada sin que alguien mire.
- **Lo que necesita una mano humana, sin cambio desde la 26:** producción sigue
  **congelada**, 290 commits y 17 migraciones sobre el último `[deploy]`
  efectivo. La compuerta bloqueará cualquier `[deploy]` mientras la base siga en
  0301.
- **Compuerta al cerrar:** `npx vitest run` **864 archivos / 11,293 pruebas / 1
  saltada / 0 fallos** · `npx tsc --noEmit -p .` **exit 0** · `npm run lint` **0
  errores, 194 avisos** · `lint:ratchet` **194/194, 0 nuevos**. `npm run build`
  no corre aquí a propósito.
- **Tablero:** `tablero-continuacion.html` + `.png`, capturado y **mirado**: 12
  rubros, notas que suman 69, 69/12 = 5.75 → 5.8.
- **Para la 27:** los tres arreglos de esta continuación aterrizaron DESPUÉS de
  que los auditores calificaran. Verificarlos es su trabajo — la evidencia de
  dos rondas seguidas dice que hay que hacerlo.
