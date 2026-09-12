COMPLETA: los 12 rubros auditados, 3 arreglos retenidos con prueba, 0 revertidos, global 6.0 → 5.2.

- **Tipo:** ronda **COMPLETA**, decidida antes de gastar un token en auditores:
  `list_pull_requests(open)` → **1 PR abierto y ninguno de auditoría** (#459,
  `cuota-diesel`, INFRA por egress bloqueado), y `git log 7bcc319..HEAD -- src/
  supabase/ normas/` → **38 commits, 116 archivos, +7,345/−171**. Rama nueva
  `claude/auditoria-30` sobre `4e36c82`. Árbol limpio → autofix habilitado.
- **Los 12 entregaron**, ninguno relanzado, ninguno vacío.
- **Global: 5.2** (antes **6.0**) · **▼ 0.8**. Bajan 9, suben 2 (backend y
  operabilidad), se queda 1 (datos, con razón nueva).
- **La reserva que va con esa cifra, y es del orquestador:** el `MAPA.md` que yo
  les escribí a los doce decía que bajar una nota con la razón «mirada más
  profunda» era «un resultado válido y esperado». Nueve bajaron y **siete citan
  esa razón**. Cuatro bajadas traen cifra que contradice a la 29 y no son eco
  (pruebas mutando 14/34; arquitectura contando seis copias, no cinco; tool
  calling con la suite congelada en 54/339; fiscal mostrando falsa la premisa del
  4). Las demás no las puedo separar. **Acción para la 31: el MAPA no debe
  sugerir ninguna dirección para las notas.**
- **122 hallazgos · 11 críticos · 42 reincidentes.**
- **Arreglado: 3**, en 3 commits atómicos, cada uno con prueba que lo reproduce y
  rojo→verde verificado:
  - `7d5bcdc` — **AG-C1 (CRÍTICO)**: el consolidado ECC reintentado se concilia y
    **no sale de la bandeja** (`marcar('ignorado')` quedó dentro de
    `if (!yaDescargado)`), así que se le ofrecía al contralor para ligarlo 1:1
    contra un ticket suelto con el acreditamiento ya repartido. Lo hallaron por
    separado agéntico y rendimiento. Falla con `expected 'disponible' to be
    'ignorado'`.
  - `b740fe0` — **ARQ-C2 (CRÍTICO, creado por esta ventana)**: la 0349 dedupó el
    cubo del 15 % en SQL y la resta gemela en TS no se movió. Medido: el previo
    sale **$90,600** cuando el correcto es **$95,300** — cupo regalado por cada
    ticket fotografiado dos veces, y el PDF declara deducible lo que ya excedió
    la RFA 2026 2.9. Antes de la 0349 el par estaba cuadrado.
  - `7a9b087` — **el guardia que debió atrapar a ARQ-C2**: tenía la ruta del
    `.sql` tecleada en una migración ya sustituida y pasaba verde comparando
    contra SQL muerto, por segunda ronda. Ahora la ruta se deriva. Verificado
    mutando.
- **Revertido: 0.** El tope de 3 vueltas se gastó entero.
- **Pendientes con razón escrita: 6** (FE-C1 5ª ronda, FIS-C1, FIS-C2, LEG-C1,
  ARQ-C1 8ª aparición, OP-C1 4ª ronda). **Propuestos verificados: 3** (PRU-C1,
  REN-30-C1, REN-30-C2 — los dos últimos tocan el camino del dinero).
- **La pregunta de la ronda, contestada:** la campaña de ~49 archivos de prueba
  nuevos **muerde sobre el argumento de una escritura** (9 de 12 mutaciones
  mueren; seguridad confirmó que el control de acceso se afirma de verdad) y **no
  muerde nada sobre la cifra de dinero impresa: 0 de 11**. +378 pruebas en la
  suite, +0 de capacidad de detectar un número mal impreso.
- **Cuatro hipótesis del propio MAPA se refutaron** (duplicación de comprobantes,
  escalada de privilegios en las 9 migraciones, acceso sin autenticar, y que la
  cobertura fuera decoración también para el acceso). Ninguna quedó en el aire.
- **Producción, medido y no inferido:** invertido respecto de la 29. 7 commits
  con `[deploy]`, cobertura efectiva **100 %**, y el pulso de hoy da `http=200
  estado=ok`, `base=0356 codigo=0356 atras=0`. Verde desde el 10-sep.
- **Compuerta al cerrar:** `npm test` **984 archivos / 12,934 pasan / 6 saltadas /
  0 fallan**, exit 0 · `tsc --noEmit` exit 0 · `lint` 0 errores, 154 avisos ·
  `lint:ratchet` 0 nuevos. Segunda ronda seguida sin las fallas INFRA de IPv6.
- **Tablero:** `tablero.html` + `tablero.png`, capturado **y mirado** — mirarlo
  encontró dos defectos de layout que medir no encontró, los dos corregidos.
  Verificado en el DOM: 12 rubros, suma 62, global 5.2.
- **INFRA de esta corrida:** el clon no traía `node_modules` (`npm ci`, 32 s); el
  Playwright del repo espera un build de Chromium que el contenedor no trae, así
  que la captura usó el Chromium preinstalado por `executablePath`; el egress de
  red está bloqueado, así que lo de producción salió de la API de GitHub vía MCP
  y no de `app.likida.ai`.
