# Auditoría 28 — síntesis

**7-sep-2026** · ronda **COMPLETA**, 12 rubros · rama `claude/auditoria-28` sobre
`d56e626` · árbol limpio al arrancar, **autofix habilitado**.

**Global: 4.4** (anterior: **5.3**) · **▼ 0.9**. Suben 0, bajan 10, se quedan 2.

---

## Lo primero, porque no es de esta rama y es de ahora

**Producción está rota mientras lees esto.** El commit `d56e626` —cuyo asunto
dice «producción al día: migraciones 0304-0347 aplicadas y verificadas»— **es un
commit vacío**: solo lleva la bandera `[deploy]`. Las migraciones sí se
aplicaron. **El código no se publicó.**

Medido, no inferido:

- Corrida **34092224844** (`salud-produccion.yml`, push, `head_sha=d56e626`):
  `compuerta: CONSTRUIR`, y luego **20 sondeos en 10 minutos**, todos
  `esperado=d56e626 desplegado=4f94490`.
- Corrida **34111978075** (schedule, 3 h 47 min después): igual.
- Verificado por mí contra la API: esa corrida está **en rojo** y el issue
  **#344** sigue abierto (`Ya hay un issue abierto (#344); no se duplica`).

Producción corre `4f94490` (3-sep, **231 commits atrás**) contra el esquema
`0347`. Y la migración **0317**, ya aplicada, **dropeó la firma de 7 argumentos**
de `gastos_fiscales_agregados_tenant` y creó una de 13 — verificado abriendo
`0317_…:43` y `:45-58`. El build vivo llama la vieja: **el panel fiscal pide una
función que ya no existe.**

`/api/health` no podía denunciarlo. Eso sí se arregló (`ddf0131`). **Publicar es
una mano humana**: Redeploy en el panel de Vercel.

---

## Las notas

Global = media aritmética de los 12, con un decimal: **53 / 12 = 4.42 → 4.4**.

| Rubro | Antes | Hoy | Δ | Porqué del movimiento |
|---|---|---|---|---|
| **Seguridad** | 8 | **7** | ▼1 | **Mirada más profunda.** El ancla del propio rubro pone en 7 el caso «las capas son una sola en algún punto», y es literalmente este repo: `proxy.ts:177` excluye `api` del matcher y `RUTAS_CON_SESION` solo cubre `/dashboard`, `/admin`, `/vendedor`, así que **las 67 rutas de `/api`** tienen una sola capa. La 27 documentó ese hecho y calificó 8 igual. Cerró además el hueco que la 27 dejó: `npm audit` da 0 vulnerabilidades sobre 752 dependencias. |
| **Pruebas** | 6 | **6** | = | **Ninguna de las tres razones aplica, y se dice así.** Los 13 archivos del rubro son byte a byte idénticos desde `06b2eca4`. Midió **15 mutaciones** sobre la superficie nueva de la ventana: **5 muertas, 10 sobrevivientes**. Entregó a tiempo, a diferencia de la 27. |
| **Modelo de datos** | 7 | **6** | ▼1 | **Mirada más profunda.** El esquema es idéntico (324 `.sql`, hasta la 0347, ni una migración nueva), pero la frase que sostenía el 7 —«no se pudo escribir un solo escenario *entra X → sale Y mal* con dinero»— **resultó falsa**. 0 críticos. |
| **Tool calling** | 6 | **5** | ▼1 | **Mirada más profunda.** Tercera ronda consecutiva sin recibir una línea (33 tools, 53 archivos, 321 pruebas, idénticos). La 27 dejó la nota quieta por eso mismo; esta ronda encontró que **quieta estaba alta**. 0 críticos, 3 altos. |
| **Frontend** | 4 | **4** | = | **Dos fuerzas del mismo tamaño, ambas escritas.** *Se atacó y subió*: `4de95a0` cerró de verdad dos hallazgos, uno de ellos con cuatro rondas encima. *Deuda que cobró factura*: el mismo commit **destapó una regresión** y el CRÍTICO del Anticipo sigue intacto línea por línea. Se cancelan. |
| **Backend y API** | 5 | **4** | ▼1 | **Mirada más profunda.** Cero commits del rubro. BE-3 resultó **más grande** de lo que la 27 midió: son **seis** agregados que suman dinero de liquidaciones rechazadas, no los tres que quedaban. Y un ALTO nuevo: el PDF de una liquidación rechazada se descarga idéntico al de una vigente. |
| **Sistema agéntico** | 5 | **4** | ▼1 | **Mirada más profunda.** Cero commits; los 9 hallazgos de la 27 **intactos línea por línea**. Lo que mueve la nota son 3 nuevos del ciclo que nadie había caminado. `ingerirRep` sin reloj sigue siendo el CRÍTICO, ahora en su segunda ronda sin recibir una línea. |
| **Cumplimiento legal** | 5 | **4** | ▼1 | **Mirada más profunda.** El CRÍTICO nuevo es de los que definen el rubro: **toda solicitud ARCO nacida del canal de texto se registra con `operador_id = NULL`, y las dos RPC ejecutoras rechazan exactamente esa fila**. La cancelación es imposible de ejecutar por el camino que el aviso de privacidad publica. |
| **Rendimiento y costo** | 5 | **4** | ▼1 | **Mirada más profunda.** Los doce archivos del rubro no recibieron una sola línea (verificado con `git diff --numstat`). Los 4 hallazgos nuevos son sobre código idéntico, medidos: **el techo diario de IA cae al piso de $5.00 para los tres planes del catálogo** —la derivación es código muerto— mientras el único plan con precio promedia 22.7 liquidaciones por día hábil. |
| **Cumplimiento fiscal** | 4 | **3** | ▼1 | **Mirada más profunda.** El ancla («3 o menos si imprime una cifra fiscal equivocada») ya no se puede sostener en 4. El CRÍTICO nuevo salió de **cruzar una ficha que nadie había cruzado nunca contra el código** (`lisr-72-73.yaml`; cero apariciones en `docs/auditoria-2*/` antes de hoy): el `<select>` sí/no del alta le gana a la clave del SAT. |
| **Arquitectura** | 4 | **3** | ▼1 | **Mirada más profunda.** Los dos pilares con que la 27 sostuvo el 4 **resultaron artefactos de medición**. El CRÍTICO va en su **6ª aparición** desde la 24, y cero de los reincidentes se cerraron. |
| **Operabilidad y DX** | 4 | **3** | ▼1 | **Deuda que cobró factura.** La 27 marcó como CRÍTICO que producción llevaba 224 commits congelada; el intento de arreglarlo **dejó producción peor que antes**: esquema nuevo, código viejo, una RPC fiscal rota y el health en verde. 3 críticos, el número más alto del tablero. |

### Una reserva honesta sobre esta global

**Diez de los doce rubros bajaron exactamente 1**, casi todos citando *mirada más
profunda* sobre código que **no cambió** — la ventana fueron 3 commits, y nueve
rubros no recibieron una línea.

Eso admite dos lecturas y no tengo cómo separarlas con lo medido hoy:

1. **Corrección real de notas infladas.** Es lo que le pasó a `pruebas` en la 27
   (8 → 6 tras medir 21 mutaciones), y el patrón se repite con evidencia nueva
   en varios rubros: la ficha `lisr-72-73` que nadie había cruzado, los seis
   agregados de BE-3 en vez de tres, los pilares de arquitectura que resultaron
   artefactos de medición.
2. **Sesgo del encargo.** El `MAPA.md` de esta ronda les dijo, con esas palabras,
   que con la ventana tan chica «la vía honesta para mover tu nota es reabrir tus
   hallazgos y mirar más hondo donde la nota anterior pudo estar inflada».
   Advertí también que dejarla quieta era una entrega correcta —y dos rubros lo
   hicieron—, pero **el empujón existió y hay que contarlo.**

**La uniformidad del −1 es sospechosa y queda anotada como tal.** Lo que aguanta
verificación son los hallazgos, no el tamaño del escalón. Si la 29 encuentra que
estas notas se pasaron de castigo, subirlas con la razón escrita es el resultado
correcto.

---

## Lo arreglado, con prueba que lo reproduce

**Dos vueltas retenidas de tres; ninguna revertida. Queda una sin gastar.**

| ID | Sha | Qué era |
|---|---|---|
| **FE-2** (ALTO) | `a28c7bb` | **La única regresión del código nuevo de la ventana.** `4de95a0` arregló el vacío de la cartera y con eso hizo alcanzable el renglón de paginación, que antes el `EstadoVacio` sustituía. `hasta` no tenía el portón que `desde` sí tiene: `(99−1)·100 + 0 = 9800` imprimía **«Facturas 0–9,800 de 350»** sobre una cartera de 350. El comentario de `vista.tsx:40-42` **ya describía el comportamiento correcto** («0–0 de N, que es la verdad, en vez de un rango inventado»); el código no lo implementaba. Rompe la regla que define al producto: nunca inventar una cifra. Rojo medido → verde. `hayMas` se dejó sobre el desplazamiento real (`consumidas`, idéntico al `hasta` viejo) para no ofrecer «Siguientes» hacia otra página vacía: el cambio solo toca lo que se imprime. |
| **OP-C1** (CRÍTICO) | `ddf0131` | **La deriva inversa era insatisfacible por construcción.** `cotejar()` clampaba con `Math.max(0, Number(codigo) − Number(base))`, así que «el esquema va 44 migraciones adelante del código» se reportaba con los valores exactos de «todo al día»: `atras: 0`, sin `motivo`, `route.ts` en `status: ok`, HTTP 200. Se agregó `adelante` como magnitud propia con su motivo, y `route.ts` degrada también con ella. `atras` conserva su semántica: `compuerta-deploy.mjs` y `production-candidate.mjs` la siguen leyendo igual. Rojo medido (`cotejar('0347','0303')` indistinguible de `cotejar('0303','0303')`) → verde. |

Una prueba preexistente (`route.test.ts:400`) afirmaba la forma exacta del objeto
con `toEqual` y ganó el campo nuevo; se actualizó **agregando** `adelante: 0` al
caso sano, sin quitar ninguna aserción.

---

## Lo verificado a mano por el orquestador

No los 130 hallazgos — **estos siete**, abriendo el archivo o midiendo contra la
API. Se dice cuáles para no insinuar lo contrario.

| Qué | Veredicto |
|---|---|
| **OP-C1** — el `DROP` de la firma de 7 args en `0317_…:43`, la firma nueva de 13 en `:45-58`, el clamp en `health/migracion.ts:100` | **CONFIRMADO**, arreglada la mitad que vive en el repo |
| **Producción en rojo** — corrida `34111978075`, issue **#344** abierto | **CONFIRMADO** contra la API de GitHub |
| **OP-C2 de la 27** (`5569437`) — ¿el arreglo cerró de verdad? | **SÍ, AGUANTA.** #344 sobrevivió tres corridas por push en verde del 7-sep. *Un arreglo no se acredita su propia nota; éste se lo ganó.* |
| **FE-2** — `vista.tsx:45` | **CONFIRMADO**, arreglado |
| **FIS-C1** — `desde_db.ts:106-113` da precedencia al perfil declarado sobre `administracion.ts:198`, que sí deriva de la clave del SAT | **CONFIRMADO**, propuesto |
| **AG-C1 / REN-C1** — `intake/rep.ts:190-241`: bucle anidado con llamadas a la base y **cero** referencias a reloj o límite (`grep` sobre el rango) | **CONFIRMADO**, dos auditores independientes y sin contacto |
| **OP-C4** — `staging-recovery.mjs:121` fija el inventario a `324/'0347'` | **SIGUE VIVO** — bloquea cualquier arreglo que exija migración nueva |

---

## Los CRÍTICOS que quedaron pendientes, con su razón

Nueve, ninguno en silencio. **Ninguno era quirúrgico.**

- **FIS-C1** — *exige una decisión de producto*: cuál fuente gana cuando la
  declarada y la derivada se contradicen. `facilidad15Declarada()` devuelve
  booleanos sin la clave, así que el arreglo obliga a plomear `regimenFiscal`
  hasta la precedencia, y el comentario de `desde_db.ts:104-105` documenta la
  precedencia actual como **deliberada**. Cambiarla de madrugada, sola, en la
  ruta del dinero, es exactamente lo que esta rutina existe para no hacer.
- **OP-C1b** (publicar el código) — *mano humana*, del lado de Vercel.
- **FIS-C2**, **LEG-C1** — *exigen migración nueva*, que **OP-C4 bloquea**: el
  repo se pone rojo (35 pruebas) con cualquier `.sql` que entre.
- **AG-C1 / REN-C1** — el arreglo es un rediseño del ciclo de ingesta
  (reanudable, con aviso al emisor), no un cambio quirúrgico.
- **ARQ-C1**, **FE-1**, **PRU-C1** — *decisiones de producto sin tomar*, las tres
  marcadas así desde rondas anteriores.
- **OP-C3** — exige cablear un servicio de fuera; no cabe en un commit del repo.

**OP-C4 es el cuello de botella de la ronda y conviene decirlo solo:** tres
CRÍTICOS distintos (FIS-C2, LEG-C1 y BE-3 del rubro de backend) mueren en el
mismo sitio. Mientras `staging-recovery.mjs:121` siga fijado a `324/'0347'`,
**este repo no acepta una migración nueva**, y una parte grande de la deuda
acumulada solo se paga con migraciones.

---

## El conteo

**130 hallazgos**: 11 críticos · 42 altos · 46 medios · 31 bajos.

Una mayoría son REINCIDENTES **por construcción**: la ventana fueron 3 commits
y el código de nueve rubros no recibió una sola línea. Eso hace la reincidencia
un dato poco informativo esta ronda — lo que importa es el daño, no el conteo de
apariciones. La excepción que sí informa: **ARQ-C1 va en su 6ª aparición** y
**FE-1 y los diez archivos de rendimiento llevan dos rondas completas sin una
línea**.

## La compuerta al cerrar

```
npm test   → 12,191 pasan · 5 fallan · 1 saltada (12,197)
tsc        → exit 0
lint       → 0 errores, 156 avisos
```

Las 5 son las **mismas 5 INFRA** de la línea base (`EAFNOSUPPORT ::1`, sin
loopback IPv6 en el contenedor). Las **+4 pruebas** contra la línea base son las
de los dos arreglos. **Lint y tsc sin cambio.**

## El tablero

`tablero.html` + `tablero.png`, capturado **y mirado**: 12 rubros contados en la
imagen, notas 4·4·4·5·7·3·4·3·6·3·4·6 = **53**, 53/12 = 4.4, y los conteos por
severidad de las tarjetas suman los 130 declarados. El color codifica la nota,
nunca el delta.
