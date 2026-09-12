# Auditoría 30 — síntesis

**12-sep-2026** · ronda **COMPLETA**, 12 rubros · rama `claude/auditoria-30` sobre
`4e36c82` · árbol limpio al arrancar, **autofix habilitado**.

**Global: 5.2** (anterior: **6.0**) · **▼ 0.8**. Bajan 9, suben 2, se queda 1.

---

## Lo primero, y es la advertencia sobre esta ronda misma

**Nueve de doce notas bajaron, y siete citan la razón «mirada más profunda». El
`MAPA.md` que yo mismo les escribí a los doce auditores les dijo, con esas
palabras, que hacerlo era «un resultado válido y esperado».**

Eso es un sesgo del orquestador y va antes que cualquier número, porque la serie
histórica es el producto de esta rutina y ya viene dando bandazos: 6.2 · 5.3 ·
6.0 · 5.3 · 4.4 · 6.0 · **5.2**. La 28 bajó diez notas exactamente 1 y anotó esa
uniformidad como sospechosa. La 29 subió once. Esta baja nueve. Tres rondas
seguidas de péndulo no son tres mediciones: son una medición inestable.

Qué **sí** puedo separar, porque está medido y no opinado:

- **Lo que bajó con evidencia dura y no por invitación.** `pruebas` midió mutando
  —**14 de 34 mueren (41 %)**, contra 35 de 44 en la 29— y dentro de eso, **0 de
  11** sobre cifras de dinero. `arquitectura` **contó** las copias del predicado
  del 15 % y salieron **seis**, no las cinco de la 29. `tool calling` midió la
  suite de su rubro: **54 archivos / 339 pruebas, el número exacto de la 29**.
  `fiscal` mostró que el 4 de la 29 se apoyaba en una premisa falsa
  (`actualizarFacilidad15` tiene dos llamadores más y los dos son del cliente).
  Esos cuatro no son eco de mi MAPA; son cifras que contradicen a la 29.
- **Lo que no puedo separar.** Los movimientos de −1 con razón «mirada más
  profunda» y sin una cifra que los ancle. Ahí el eco de la invitación es
  indistinguible de la corrección real.

**Acción concreta para la 31: el MAPA no debe contener ninguna frase que sugiera
una dirección para las notas.** Ni «subir es esperado» ni «bajar es válido». Que
los auditores lleguen sin saber qué se espera de ellos es la única forma de que
la serie mida el código y no el encargo.

---

## Las notas

Global = media aritmética de los 12, con un decimal: **62 / 12 = 5.17 → 5.2**.

| Rubro | Antes | Hoy | Δ | Porqué del movimiento |
|---|---|---|---|---|
| **Backend y API** | 6 | **7** | ▲1 | **Se atacó y subió.** BE-3 —los seis agregados que sumaban dinero de liquidaciones rechazadas, su reincidente de 3ª ronda— **cerró de verdad**: la `0348` cubre las seis RPC y solo esas seis, y su test SQL siembra el caso divergente (rechazada de $9,000 con `diferencia=500` el mismo día), así que revertir cualquiera de los seis `WHERE` pone en rojo un `raise` distinto. No cerró la **clase**: el mismo predicado falta en `libro_viaje.ts:590`. |
| **Operabilidad y DX** | 6 | **7** | ▲1 | **Se atacó y subió**, por un eje y no el del crítico. El hallazgo de publicación de la 29 se **invirtió, medido**: 7 commits con `[deploy]`, **cobertura efectiva 100 %**, y el pulso de hoy (10:15 UTC) da `http=200 estado=ok`, `base=0356 codigo=0356 atras=0`, `desplegado=cfa00ab=ultimo_[deploy]`. Producción lleva verde desde el 10-sep. OP-C1 sigue abierto y `15fd8d3` le costó un ALTO nuevo. |
| **Modelo de datos** | 7 | **7** | = | **Se sostiene, con razón nueva.** El argumento que sostenía el 7 en la 29 («el esquema no cambió, 3ª ronda seguida») desapareció: entraron **9 migraciones**. El 7 lo gana el trabajo por mérito propio — 8 de 9 traen prueba que hace divergir la versión vieja de la nueva, las 7 nuevas de `supabase/tests/` están cableadas en `ci-postgres.yml`, y **ninguna cambia firma** (que es el bug que ya ocurrió en la 28 con la 0317). No sube a 8 por cuatro MEDIO. |
| **Seguridad** | 7 | **6** | ▼1 | **Deuda que cobró factura + mirada más profunda.** Las 9 migraciones salieron **limpias de escalada** —las 12 funciones conservan cláusula de seguridad, `search_path` y firma— y `npm audit` da 0/751. Baja porque el `no-store` de `0754652` se aplicó **ruta por ruta**: quedan **13 salidas 200 más** con datos de un tenant, autenticadas por cookie, sin la marca, entre ellas `/v1/liquidaciones` y las transcripciones de WhatsApp. El parche por enumeración es la deuda. |
| **Frontend** | 6 | **5** | ▼1 | **Mirada más profunda.** En 38 commits su rubro recibió **2 archivos de producción**, y los **5 hallazgos abiertos de la 29 siguen los 5 intactos: cero cierres**. FE-C1 entra en su **5ª ronda**. Un 6 sobre un rubro que no recibió líneas y no cerró nada era una nota inflada. |
| **Cumplimiento fiscal** | 4 | **3** | ▼1 | **Mirada más profunda**, y ésta con cifra: el 4 de la 29 se apoyó en «el radio bajó a la consola del superadmin», y es **falso** — `actualizarFacilidad15` tiene dos llamadores más y los dos son del cliente. El cotejo contra la clave del SAT corre **después** de la escritura que vigila. Vuelve al tramo «imprime una cifra fiscal equivocada», que es donde estaba. |
| **Cumplimiento legal** | 5 | **4** | ▼1 | **Mirada más profunda.** 6 reincidentes intactos y un CRÍTICO nuevo que ninguna ronda había visto: la coordenada exacta del operador queda **en texto** dentro de `coordinacion_proveedor.mensaje_preparado`, y ni la purga de 90 días que el aviso promete ni la cancelación ARCO la alcanzan. El ARCO se auditó tabla por tabla, que es lo que lo destapó. |
| **Pruebas** | 7 | **6** | ▼1 | **Mirada más profunda**, medida mutando: **14 de 34 (41 %)**, contra 35 de 44 en la 29. El desglose es el hallazgo: sobre el **argumento de una escritura** (tenant, userId, id) muere 9 de 12; sobre **la cifra de dinero que la pantalla imprime, 0 de 11**. Lo mejor del rubro son los 6 tests SQL nuevos, cableados en CI. |
| **Rendimiento y costo** | 6 | **5** | ▼1 | **Mirada más profunda.** REN-C1 **mutó**: la mitad reintentable cerró de verdad y con prueba que muere al revertir, pero **la suma de tiempo no se movió un segundo** (331.2 s contra `maxDuration = 300`, igual que en la 29), y los **6 abiertos siguen los 6**. Dos CRÍTICOS nuevos, uno nunca antes reportado. |
| **Tool calling** | 7 | **5** | ▼2 | **Mirada más profunda + deuda.** **0 de 8 abiertos cerrados**, y la suite del rubro dio **54 archivos / 339 pruebas: el número exacto de la 29** — la campaña de +49 archivos no tocó este rubro. El ALTO que mueve la nota: cuatro rondas verificaron las guardas del *selector* del piloto de visión; ninguna preguntó por el **valor** que el modelo teclea en un formulario fiscal. Las 33 tools siguen respetando `properties: {}`. |
| **Arquitectura** | 4 | **3** | ▼1 | **Deuda que cobró factura**, con componente de mirada más profunda. El predicado del 15 % **no bajó de cinco: subió a seis**, y las tres SQL se reescribieron en esta misma ventana. La 29 no contaba `cierre_insumos_hash`, que ya estaba viva. ARQ-C1 entra en su **8ª aparición** con `git diff` vacío sobre su camino. Y la ventana **creó** un CRÍTICO nuevo (ARQ-C2). |
| **Sistema agéntico** | 7 | **4** | ▼3 | **Mirada más profunda + deuda.** El +3 de la 29 no lo sostenía el código: el único commit que tocó el rubro en toda la ventana fue el par de REN-C1, y los **5 reincidentes siguen intactos línea por línea**. El CRÍTICO de `ingerirRep` que la 29 declaró cerrado **sigue cerrado de verdad** (verificado en `rep.ts:209-215` con su ancla en `rep.test.ts:244`) — eso se le acredita. Pero un 7 con cinco reincidentes intactos y un ciclo que se reintenta sin cerrarse era la nota más inflada del tablero. |

---

## Los 11 críticos — ninguno sin estado

**Arreglados con prueba que los reproduce (2 críticos + 1 guardia), 3 commits
atómicos, 0 revertidos:**

- **`7d5bcdc` — AG-C1 (CRÍTICO).** El consolidado ECC reintentado se concilia y
  **no sale de la bandeja**: el arreglo de REN-C1 dejó `marcar(...,'ignorado')`
  dentro de `if (!yaDescargado)`, y el sello nace en `'disponible'`, que es
  literalmente «nadie reportó este gasto». El contralor veía un ECC ya conciliado
  línea por línea ofrecido para ligarlo **1:1 contra un ticket suelto** —lo que
  prohíbe la regla 3.3.1.7— con el acreditamiento ya repartido. Reintentar y no
  cerrar el ciclo es **peor** que no reintentar: antes quedaba visiblemente sin
  conciliar; ahora quedaba conciliado **y** ofrecido, que se ve correcto y no lo
  está. Lo hallaron por separado **agéntico y rendimiento**, sobre la misma
  línea. Prueba: falla con `expected 'disponible' to be 'ignorado'`.
- **`b740fe0` — ARQ-C2 (CRÍTICO, creado por esta ventana).** La `0349` dedupó
  copias del mismo comprobante en el cubo del 15 % **en SQL**, y la resta gemela
  que vive en TypeScript (`cuadre/desde_db.ts:175`) no se movió. **Antes de la
  0349 el par estaba cuadrado** —los dos contaban doble— así que no es deuda
  vieja: lo creó el arreglo, y del lado que **regala cupo**. Medido: acumulado
  $100,000 y un ticket de diésel en efectivo de $4,700 fotografiado dos veces →
  el previo sale **$90,600** cuando el correcto es **$95,300**. El PDF declara
  deducible combustible que ya excedió la facilidad de la RFA 2026 2.9. Se reusó
  `copiasDeComprobante` de `engine.ts` en vez de reimplementar el predicado.
- **`7a9b087` — el guardia que debió atrapar a ARQ-C2.**
  `fiscal_agregado_15pct.test.ts` existe para impedir que `engine.ts` y la RPC
  digan cosas distintas, y llevaba dos rondas haciendo **eso mismo consigo**: la
  ruta del `.sql` estaba **tecleada** en la `0345`, sustituida por la `0349` en
  esta ventana. Pasaba verde comparando contra SQL muerto. Ya había ocurrido en
  la ronda 25. Se arregló la causa raíz —la ruta se **deriva** como la última
  migración que define la función— y se ancló con una aserción. Verificado
  **mutando**: fijándola de vuelta a la 0345, muere.

**Pendientes con razón escrita (6):** FE-C1 (5ª ronda; exige alcance de producto,
no existe un solo `update` de `viaje.anticipo` en `src/`) · FIS-C1 y FIS-C2 (el
cotejo corre después de la escritura y en una sola dirección; el arreglo toca
onboarding y la entrevista de WhatsApp, no es quirúrgico) · LEG-C1 (exige
migración de purga y base viva para verificar) · ARQ-C1 (8ª aparición, rediseño)
· OP-C1 (4ª ronda; `94de18f` arregló la pantalla, que **no era el hallazgo** —
OP-C1 siempre fue sobre el log y el issue, que no cambiaron una línea).

**Propuestos, verificados y no arreglados (3):** PRU-C1 (son 11 aserciones de
cobertura, no un bug puntual) · REN-30-C1 y REN-30-C2 (los dos tocan el camino
del dinero y su arreglo no es quirúrgico — exactamente la razón por la que la 29
no tocó REN-C1).

**El tope de 3 vueltas se gastó entero.** No quedó vuelta sin usar.

## Descartados — la prueba de que la verificación ocurrió

Ninguno de los verificados a mano resultó falso, pero **cuatro hipótesis que el
propio MAPA señalaba como los hallazgos más valiosos posibles se refutaron**, y
eso vale anotarlo porque mide la calidad del encargo, no solo la del código:

1. «El reintento del consolidado duplica comprobantes» → **falsa**, lo impiden el
   `unique (cfdi_xml_id, indice)`, la salida temprana y la reanudación por sello.
   La refutó `fiscal`, contra su propio encargo.
2. «Alguna de las 9 migraciones pierde `search_path` o gana `SECURITY DEFINER`» →
   **falsa**, las 12 funciones conservan cláusula, `search_path` y firma exacta.
3. «Hay un camino de acceso sin autenticar a datos de un tenant» → **no se
   encontró**, y se dijo cómo se buscó: 72 `route.ts`, 47 páginas de
   `/dashboard`, 124 llamadas al resolvedor contra la ruta real, cero
   discrepancias.
4. «La cobertura nueva es decoración también para el control de acceso» →
   **falsa**: sí prueba las dos capas. La decoración está en el eje del **dinero**.

Corrección para la skill: `src/middleware.ts` **no existe** en el repo, aunque
`references/rubros.md` se lo asigna a backend.

## La pregunta que traía esta ronda, contestada

La ventana era una **campaña de cobertura**: 20 de 38 commits, ~49 archivos de
prueba nuevos, primera cobertura para ~35 páginas, +378 pruebas en la suite. La
pregunta era si muerde o solo prueba que el componente renderiza.

**Las dos mitades importan.** Sobre el **argumento de una escritura** muerde: 9
de 12 mutaciones mueren, y `seguridad` confirmó por separado que esas seis
páginas sensibles sí afirman las dos capas de acceso y que el `tenantId` sale del
closure. Sobre **la cifra de dinero que la pantalla imprime** no muerde nada:
**0 de 11**. El conteo de la suite subió 378 pruebas y la capacidad de detectar
un número mal impreso subió cero — en el producto cuya regla número uno es
«nunca inventar una cifra».

## Reincidentes: 42 de 122 hallazgos

Un hallazgo que vuelve es peor noticia que uno nuevo. Los que más pesan: **ARQ-C1
en su 8ª aparición**, **FE-C1 en su 5ª**, **OP-C1 en su 4ª**, los **8 de tool
calling** (0 cerrados) y los **5 de agéntico** (intactos línea por línea).

## Compuerta al cerrar

```
npx vitest run   → Test Files 984 passed (984)
                   Tests 12934 passed | 6 skipped (12940)   exit 0
npm run typecheck → exit 0
npm run lint      → 154 problems (0 errors, 154 warnings)   exit 0
npm run lint:ratchet → 154/194 heredados; 0 nuevos; 0 errores
```

Línea base al arrancar: 12,931 pasan. Al cerrar: 12,934 — **+3, una por arreglo**.
Segunda ronda seguida sin las 5 fallas INFRA de IPv6.

## Tablero

`tablero.html` + `tablero.png`, capturado **y mirado**. Mirarlo encontró dos cosas
que medir no encontró y que quedaron corregidas: la columna de estado salía
cortada en el borde derecho por un `white-space: nowrap`, y el arreglo de ancho de
columna aplastó la primera columna de las otras dos tablas a una tira vertical.
Verificado en el DOM al capturar: **12 rubros, suma 62, global 5.2**, sin desborde
horizontal.

## Verificación

El orquestador abrió y confirmó **3** hallazgos a mano contra el código —AG-C1,
ARQ-C2 y el guardia del 15 %—, no los 122, y los tres se arreglaron. La síntesis
dice cuáles. **Ninguno de los verificados resultó falso esta ronda**; los
descartados de arriba son hipótesis del MAPA que los propios auditores refutaron.

Los tres arreglos entraron **después** de que los doce calificaran, así que su
efecto **no está en las notas de hoy**: se le acredita a la 31.
