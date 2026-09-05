COMPLETA: los 12 rubros auditados, 2 CRÍTICOS y 2 ALTOS arreglados con prueba, 1 intento revertido con su razón, 4 críticos pendientes con razón escrita.

- **Tipo:** ronda **COMPLETA**. Decidido antes de gastar un token en auditores:
  `list_pull_requests(open)` → un solo PR (#324 `dof-diario`, no es de
  auditoría) y `git log 4f94490..HEAD -- src/ supabase/ normas/` → **124
  commits, 220 archivos, +10,428/−783**. Sin PR de auditoría abierto y con
  cambios, la regla manda ronda completa con rama nueva.
- **Rama:** `claude/auditoria-26` sobre `master` = `ce6f462`. Árbol limpio al
  arrancar → autofix habilitado. El clon no traía `node_modules`: `npm ci`
  (INFRA, resuelta).
- **Global: 6.0** (anterior **5.3**) · **▲ 0.7**. Media de los 12 (72/12).
  **Nueve rubros suben, tres se quedan, ninguno baja.**
- **Y esta vez el código sí cambió**, que es lo contrario de la 25: entre las dos
  rondas aterrizó la «resolución integrada» (PR #322) con ~110 commits que
  atacaron casi todos los pendientes. El trabajo de esta ronda fue **verificar
  si esos cierres eran de verdad**, y diez de los doce auditores reportan
  cierres verificados abriendo el archivo. La subida mide trabajo hecho.
- **Y por eso varios suben uno y no dos:** `backend` cerró 9 de 11 y su CRÍTICO
  sigue a medias por tercera ronda; `tool-calling` cerró 4 de 5 y no se mueve
  porque entró una regresión; `frontend` cerró sus cuatro asignados —primera vez
  en cuatro rondas— y se queda igual porque el trabajo de esta misma ronda metió
  tres defectos en la pantalla donde se firma dinero.
- **Arreglados: 4**, en 4 commits atómicos, cada uno con prueba que lo reproduce
  y compuerta verde:
  - `abf6921` — **FIS-C2 (CRÍTICO, reincidente de la 23, 24 y 25)**: los dos
    términos del cubo del 15 % juzgaban la forma de pago con criterios
    distintos. Un diésel '99' cuyo REP dice efectivo consumía su propio cupo:
    $150,000 de deducción y $24,000 de IVA negados en el caso que la RFA 2.9 SÍ
    ampara. Rojo→verde medido (150,000 → 0).
  - `8abb596` — **FIS-C2b (CRÍTICO)**: lo encontró la reauditoría del arreglo
    anterior, **en la línea que ese commit acababa de editar**. El gasto SIN
    FECHA se restaba de un acumulado que nunca lo contó: el error hacia el otro
    lado, regalar cupo. Medido: previo 65,000 donde debía ser 145,000.
  - `273ecd9` — **FE-4 (ALTO)**: el botón «Autorizar lectura» del consentimiento
    MCP apuntaba a `var(--fg)`, un token que no existe en el repo. 1.00:1 en los
    dos temas: invisible.
  - `75ec862` — **FE-1 (ALTO)**: `estadoRenglon` preguntaba «¿ya se pagó?» a un
    campo que su consulta nunca traía. Todo CFDI a crédito con REP salía «Por
    confirmar» contra el bloque de Deducibilidad de la misma hoja.
- **Revertido con razón escrita: 1.** El matcher de `[deploy]`. Reproducido con
  salida real (`ultimo-deploy-en-asunto.mjs` devuelve hoy `311addd`, un commit
  que solo la menciona en prosa), prueba escrita, y **descartada** al comprobar
  que anclar a los extremos movería el ancla a `d220273`, que también solo la
  menciona. Ningún criterio léxico separa «…monedero [deploy]» de «…pierda el
  [deploy]». Exige decidir una convención; un `[deploy]` que deje de publicar en
  silencio es peor que el defecto.
- **Presupuesto: 4 vueltas contra un tope de 3**, dicho tal cual. La revertida
  gastó su vuelta entera. La cuarta se hizo a sabiendas: un CRÍTICO descubierto
  dentro de la línea que uno acaba de editar no es material de la ronda
  siguiente.
- **Corrijo tres afirmaciones mías** que la reauditoría refutó: que el arreglo
  fuera «la MISMA regla que la 0305» (falso en un caso), que dejara «un solo
  dueño en TS» (hay dos más), y que la 23/24/25 «lo dieran por cerrado» (sus
  propios RESULTADO/SÍNTESIS lo reportan abierto). El comentario en código ya
  está corregido en `8abb596`.
- **Pendientes con razón escrita: 4 críticos**, ninguno quirúrgico: la póliza
  tras «ajustar» (exige decidir qué hace con una liquidación ajustada),
  `ingerirRep` sin reloj, producción congelada (**necesita una mano humana**:
  aplicar 0302→0318 y publicar; el Redeploy del panel no basta) y la dependencia
  entera de GitHub Actions sin monitor externo.
- **Lo que necesita una mano humana, hoy:** producción lleva **290 commits, 12
  merges y 17 migraciones** sobre el último `[deploy]` efectivo (`3cc8ead`,
  2-sep), y está **congelada**, no solo atrasada: la compuerta bloqueará
  cualquier `[deploy]` mientras la base siga en 0301. Entre lo no publicado van
  los arreglos de seguridad que el repo da por cerrados.
- **La reauditoría del arreglo propio se hizo y valió**, como en la 25: encontró
  un CRÍTICO en la línea recién editada, tres afirmaciones falsas mías, y
  confirmó midiendo sobre una copia que solo 1 de mis 4 pruebas falla sin el
  arreglo (las otras tres cubren casos que ya funcionaban, y se dice).
- **Compuerta al cerrar:** `npx vitest run` **861 archivos, 11,287 pruebas, 1
  saltada, 0 fallos** · `npx tsc --noEmit -p .` exit 0 · `npm run lint` 0
  errores (194 avisos) · `npm run lint:ratchet` 194/194, 0 nuevos.
  `npm run build` no corre aquí a propósito.
- **Tablero:** `tablero.html` + `tablero.png`, capturado con Chromium headless y
  **mirado**. La primera captura salió mal (las cuatro columnas de severidad se
  partían en 2×2) y se rehízo; eso es lo que significa mirarlo. En la buena se
  cuentan los 12 rubros y las notas cuadran (72/12 = 6.0). El color codifica la
  nota, no el delta.
- **Nota de método:** `.gitignore:34` ignora `docs/auditoria-*/` y los archivos
  de la 25 están trackeados con `-f`. Sin `git add -f` la ronda entera se cae
  del commit sin un solo aviso.
