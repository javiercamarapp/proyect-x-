# Modelo de datos y esquema — auditoría 26

**Nota: 6/10** (antes 5). Razón del movimiento: **el código cambió**. Los ocho
hallazgos abiertos de la 25 se atacaron con migración propia y **siete cerraron
de verdad** —verificado archivo por archivo, no por el mensaje del commit—: el
dominio de `llm_costo` (0304), el índice parcial de `factura_saas` (0309), la
FK compuesta de `app_user` (0310), el dominio de `modelo_rol` (0311), el revoke
de `tenant_perfil_merge` (0312/0315), la doble definición de «liquidación
emitida» (0307) y el sub-chequeo desdentado del bloque 249 (`3488b26`). Dos de
esos cierres además vinieron con **prueba que cruza el tipo de TS contra el
CHECK vivo** (`costos_dominio.test.ts`,
`agente_definicion_modelo_rol_dominio.test.ts`), que es exactamente el arnés que
la 25 dijo que faltaba. La nota no sube más porque el arreglo de DATOS-C1 —la
0306, la migración más grande de la ronda— **cerró la parte que estaba dentro de
la transacción y dejó fuera la que no**, y de paso abrió dos huecos nuevos del
mismo tipo: superficie fiscal que ahora se escribe desde un parámetro `jsonb`
sin una sola restricción que la ate al hecho que dice describir.

**El riesgo mayor hoy:** el botón **Ajustar** del panel acepta un monto nuevo
para cualquier comprobante —incluidos los que ya traen CFDI timbrado— y la base
guarda ese monto **junto a la base gravable del XML original, sin tocarla y sin
quejarse**. Una sola liquidación así deja el asiento contable del comprobante en
un estado que el propio `poliza.ts` declara imposible, y el export de la póliza
del **periodo entero** contesta 409.

---

## Hallazgos

### [ALTO] Ajustar el monto de un comprobante que YA trae CFDI deja el total de la fila y su propia base gravable describiendo dos comprobantes distintos, y ninguna restricción lo impide
`supabase/migrations/0306_ajustar_regenera_desglose_y_pdf.sql:182,209` ·
`supabase/migrations/0281_poliza_v2_cubetas_sin_copias.sql:44-50` ·
`src/app/dashboard/[id]/revision-panel.tsx:153-160` ·
`src/lib/likida/contabilidad/poliza.ts:203-205,230,249-258` ·
`src/app/api/export/poliza/route.ts:354,358-369`

La 0306 escribe **una sola columna** del comprobante:

```
0306:209:      update gasto set monto = v_nuevo where id = v_gasto.id;
```

y sus únicos guardarraíles sobre `v_nuevo` son de rango absoluto:

```
0306:182:      if v_nuevo is null or v_nuevo <= 0 or v_nuevo > 1000000 then
```

La cabecera de la propia migración declara que **no se tocan**
`sub_total`/`iva_traslado`/`ieps_traslado` porque «son el HECHO del CFDI». La
decisión es correcta; lo que falta es que la base impida que el `monto` se aleje
de ese hecho. Barrí las diez restricciones vivas de `gasto`
(`gasto_monto_no_negativo` 0070:41, `gasto_importes_no_negativos` 0281:44-50,
`gasto_descuento_no_excede` 0281:57-59, `gasto_cfdi_orden_positivo`,
`gasto_bloqueo_coherente`, `gasto_ocr_confianza_rango`,
`gasto_fecha_no_prehistorica`, `gasto_descuento_no_negativo`,
`gasto_metodo_pago_dominio`, `gasto_pagado_forma_formato`): **ninguna relaciona
`monto` con `sub_total + iva_traslado + ieps_traslado`.** El piso de la 0281
pone `>= 0` a cada columna por separado y nada más.

Y el camino no exige un script: el panel pinta un `<input name="monto:<gastoId>">`
por **cada** comprobante, sin mirar si trae `cfdi_uuid`
(`revision-panel.tsx:157`), y la RPC solo rechaza los que el motor ya había
excluido por `duplicado`/`monto_invalido` (LR019).

**Escenario, con valores.** VJ-0007, `viaje.anticipo = 10000`, un solo
comprobante: caseta con CFDI timbrado — `gasto.monto = 8000.00`,
`sub_total = 6896.55`, `iva_traslado = 1103.45`, `cfdi_uuid = '3f2a…'`.
Liquidación firmada. El contralor cree que el OCR metió un cero de más, abre
**Ajustar** y captura `800`:

```
select revisar_liquidacion(
  '…tenant…', '…liq…', 'ajustar', 'el ticket dice 800',
  '[{"gastoId":"…","montoNuevo":800}]'::jsonb, '…actor…', null,
  '{"totalComprobado":800,"diferencia":9200,"estatus":"con_diferencias",
    "diferencias":[],"iepsAcreditable":0,"litrosDieselAcreditables":0,
    "ivaAcreditable":0,"peajeAcreditable":0}'::jsonb);
```

Pasa LR016 (800 > 0 y < 1,000,000), pasa LR018 (≠ 8000), pasa LR019, pasa LR020
(800 = 800 + (800 − 8000) + 8000 … la delta cuadra). `gasto_no_tras_liquidar` se
salta por el GUC (0300:36-40). **Commit.** La fila resultante dice
`monto = 800` con `sub_total = 6896.55` e `iva_traslado = 1103.45`: el IVA solo
es el **138 %** del total del comprobante. Ni un aviso de la base.

**Consecuencia.** Fin de mes, el contador exporta la póliza:
`comprobado = anticipo − diferencia = 800`, `subtotalDeclarado = 6896.55`
(`poliza.ts:203-205`, que lee `gasto.sub_total` vía `poliza_datos_tenant`), y
`impuestoNoAcreditado = 800 + 0 − 6896.55 − 0 = −6096.55` (`poliza.ts:230`).
Cae en la rama `< -0.01` (`poliza.ts:249`) → `falta.push('la póliza no cuadra:
el comprobado (800.00) es menor que la base más el IVA acreditable (6896.55) por
6096.55')` → `route.ts:354` mete el folio en `bloqueos` → `route.ts:358` devuelve
**409 `polizas_incompletas` para el periodo COMPLETO**. Un solo ajuste tecleado
en el panel bloquea el asiento de todas las liquidaciones del mes, y el mensaje
que el contralor recibe le pide «revisar la liquidación a mano» sin decirle cuál
de las dos cifras es la mentira. En paralelo,
`gastos_fiscales_agregados_tenant` (0317) sigue sumando esos $1,103.45 en la
celda de «IVA acreditable documentado».

**Causa raíz probable:** la 0306 razonó sobre qué NO tocar (correcto) y no sobre
qué queda sin atar cuando el otro lado sí se mueve; el piso de la 0281 se diseñó
para signos invertidos del XML, no para un total editado a mano después.

---

### [ALTO] Las cuatro columnas acreditables de `liquidacion` pasan de un parámetro `jsonb` al disco sin piso, sin techo y sin ninguna relación con los comprobantes que dicen resumir
`supabase/migrations/0306_ajustar_regenera_desglose_y_pdf.sql:232-235` ·
`supabase/migrations/0146_gasto_finanzas_y_dominios_liquidacion.sql:61-64` ·
`supabase/migrations/0007_acreditamiento.sql:9-11` ·
`supabase/migrations/0021_liquidacion_litros_diesel.sql:13` ·
`supabase/migrations/0308_acreditables_solo_firmadas.sql:44-49` ·
`supabase/verificaciones.sql:17213-17217,17223`

La 0306 abre una puerta nueva a cuatro columnas fiscales:

```
0306:232:  ieps_acreditable = round(coalesce((p_recalculo ->> 'iepsAcreditable')::numeric, 0), 2),
0306:233:  litros_diesel_acreditables = round(coalesce((p_recalculo ->> 'litrosDieselAcreditables')::numeric, 0), 3),
0306:234:  iva_acreditable  = round(coalesce((p_recalculo ->> 'ivaAcreditable')::numeric, 0), 2),
0306:235:  peaje_acreditable = round(coalesce((p_recalculo ->> 'peajeAcreditable')::numeric, 0), 2),
```

Hasta la 0306 estas cuatro solo las escribía `guardar_liquidacion_tx` con lo que
el motor había calculado. Ahora las escribe **lo que venga en un `jsonb`**, y el
guardarraíl LR020 (0306:222-227) valida **una sola** llave, `totalComprobado`.
Las restricciones vivas de `liquidacion` son ocho y las revisé una por una
(`liquidacion_totales_no_negativos`, `liquidacion_diferencia_cuadra` 0146:61-68;
`liquidacion_diferencias_arreglo` 0158:580; `liquidacion_revision_dominio`,
`_firma`, `_motivo`, `liquidacion_ajustes_arreglo` 0299:75-95;
`liquidacion_pdf_historial_arreglo` 0306:66): **ninguna nombra las cuatro
columnas acreditables.** El piso de la 0146 cubre exactamente dos:
`check (total_comprobado >= 0 and total_anticipo >= 0)`.

Lo demuestra el propio bloque de verificación de la migración, que es la prueba
más limpia que puedo ofrecer sin base: siembra **un solo gasto de diésel de $800
sin CFDI y sin `iva_traslado`** (`verificaciones.sql:17223`) y le manda a la RPC
`'ivaAcreditable', 1200.75` y `'peajeAcreditable', 60`
(`verificaciones.sql:17216`). El bloque espera —correctamente, para lo que él
mide— `bueno-iva=t`: la base guarda $1,200.75 de IVA acreditable sobre un
comprobante que no tiene un peso de IVA desglosado.

**Escenario, con valores.** Un script de soporte, la consola SQL de Supabase, o
un `cuadrarDesdeDB` que devuelva NaN→0 mal manejado:

```
select revisar_liquidacion('…tenant…','…liq…','ajustar','reproceso', 
  '[{"gastoId":"…","montoNuevo":8000}]'::jsonb, '…actor…', null,
  '{"totalComprobado":8000,"diferencia":2000,"estatus":"cuadrada","diferencias":[],
    "iepsAcreditable":0,"litrosDieselAcreditables":-40,
    "ivaAcreditable":950000.00,"peajeAcreditable":0}'::jsonb);
```

Entra. `iva_acreditable = 950000.00` y `litros_diesel_acreditables = -40` sobre
una liquidación de $8,000 (el único freno es el desbordamiento de
`numeric(12,2)` a los diez mil millones). De paso `estatus = 'cuadrada'` convive
con `diferencia = 2000`, que tampoco tiene restricción que los ate.

**Consecuencia.** `acreditables_liquidacion_tenant` (0308:44-49) suma
`iva_acreditable` de todas las liquidaciones **firmadas**, y `'ajustada'` es
firmada: la tarjeta «IVA acreditable de tus liquidaciones — LIVA art. 5» del
panel del contador y la herramienta de chat `acreditables_periodo` reportan
$950,000 que ningún CFDI respalda, con la etiqueta de cifra medida. Es la regla
número uno del producto —«nunca inventar una cifra»— rota desde la capa que
debería ser la última red, y con litros negativos que además envenenan el
estímulo del LIF 20-A-IV.

**Causa raíz probable:** el arreglo de DATOS-C1 movió el cálculo a TypeScript
por una razón buena (no tener dos motores) y trasladó la confianza al llamador
sin dejar en la base ni el piso más barato; LR020 se escribió para la carrera
entre lectura y escritura, no para la forma del dato.

---

### [ALTO · REINCIDENTE, DATOS-C1 — cierre PARCIAL] Los dos sellos de entrega y `pdf_url` se quedaron FUERA de la transacción de la RPC: tres retornos tempranos dejan la base afirmando que el PDF viejo ya se entregó
`supabase/migrations/0306_ajustar_regenera_desglose_y_pdf.sql:44-50` ·
`src/lib/likida/revision_recalculo.ts:165,167,186,193-196,207,217-220` ·
`src/lib/likida/revision.ts:487-501` ·
`supabase/migrations/0279_liquidacion_sellos_de_entrega.sql:27-28`

**La mitad grande cerró de verdad** y lo digo primero: `revisar_liquidacion`
ahora exige `p_recalculo` para ajustar (LR021), lo cruza contra la delta (LR020)
y sustituye `total_comprobado`, `diferencia`, `estatus`, `diferencias` y las
cuatro acreditables **en el mismo UPDATE**, dentro del mismo candado. La
divergencia entre las tres cifras que la 25 reportó ya no puede nacer por esa
vía.

Lo que quedó fuera es la parte que el hallazgo nombraba explícitamente —«incluido
el sello que dice que el PDF viejo ya se entregó»— y la migración lo dice ella
misma:

```
0306:45: --  3. Los dos sellos de entrega de la 0279 (`entregada_operador_en`,
0306:46: --     `avisada_oficina_en`) se limpian en el MISMO recálculo (TypeScript, no
0306:47: --     aquí — no son parte de `revisar_liquidacion`)
```

La limpieza vive en un `update` suelto, **después** de que la RPC ya hizo commit,
en una función que por diseño nunca lanza (`revision.ts:493-500`, best-effort):

```
revision_recalculo.ts:207:  .update({ pdf_url: rutaContralor, entregada_operador_en: null, avisada_oficina_en: null })
```

y hay **tres caminos que llegan al `return` sin pasar por esa línea 207**:
`:165` (el viaje no se pudo releer), `:167` (el operador no se pudo releer) y
`:193-196` (`if (!okContralor)`, la subida del PDF a Storage falló), más el
`catch` de `:217-220` si `generarLiquidacionPDF` lanza. Ninguna restricción de
la base cubre esa ventana: `grep -rn "entregada_operador_en"
supabase/migrations/*.sql` devuelve la 0279 que la crea, un índice parcial, y el
comentario de la 0306 — cero triggers, cero CHECK.

**Escenario, con valores.** Caseta leída $8,000 → $800.
`liquidacion.pdf_url = 'ten-01/vj-0007.pdf'` (con $800 impreso),
`entregada_operador_en = '2026-09-03T10:04Z'`. El contralor pulsa Ajustar y
captura 8,000. La RPC confirma: `gasto.monto = 8000`,
`total_comprobado = 8000`, `iva_acreditable` recalculado, `revision = 'ajustada'`.
Acto seguido `regenerarPdfTrasAjuste` archiva el PDF viejo en
`ten-01/vj-0007-ajustada-1757…pdf` (`:186`) y la subida del PDF nuevo devuelve
error de Storage (cuota, 5xx del bucket, un `Buffer` de 12 MB). `:193` regresa
`{regenerado:false}` **antes** de la línea 207. Estado final aceptado por la
base: `total_comprobado = 8000`, `pdf_url` apuntando al PDF de **$800**, y
`entregada_operador_en` con fecha, es decir «ese papel ya se le dio al chofer».

**Consecuencia.** No hay reintento: `regenerarPdfTrasAjuste` solo se llama desde
`revisarLiquidacion` (`revision.ts:495`), y LR010 impide volver a firmar la misma
liquidación, así que el contralor no puede repetir la acción para forzar la
regeneración. El circuito de reentrega del chofer lee el sello y no vuelve a
mandar nada. Queda una liquidación firmada de $8,000 cuyo único PDF vigente dice
$800 y cuya base afirma que ya se entregó, sin ninguna columna que diga «este
papel está viejo» — el estado exacto que DATOS-C1 describía. Baja de CRÍTICO a
ALTO porque ahora solo se alcanza por una falla del almacén, no por el camino
feliz.

**Causa raíz probable:** el arreglo separó «lo que la base garantiza» de «lo que
el papel refleja» y puso la frontera en el commit de la RPC; los dos sellos
describen el papel pero viven en la fila, y nadie los movió al lado correcto de
esa frontera ni les dejó una marca de invalidez.

---

### [MEDIO] `liquidacion_historico` —la tabla que el repo declara «la constancia»— no archiva la firma humana: reabrir un viaje borra quién firmó, cuándo, con qué motivo y qué ajustó a mano
`supabase/migrations/0159_rpcs_atomicas.sql:159-179,228-238` ·
`supabase/migrations/0299_revision_liquidacion.sql:56-61` ·
`supabase/migrations/0306_ajustar_regenera_desglose_y_pdf.sql:60-62` ·
`supabase/migrations/0279_liquidacion_sellos_de_entrega.sql:27-28` ·
`supabase/migrations/0155_purgas_y_bucket_comprobantes.sql:219-238`

`liquidacion_historico` se creó en la 0159 con **quince** columnas y su comentario
dice: «es la constancia de un papel que el operador YA recibió y que el borrado
hacía desaparecer sin rastro». Desde entonces `liquidacion` ganó nueve columnas
más y **ninguna entró al archivo ni al INSERT de `reabrir_viaje_tx`**
(`0159:228-238`, que enumera las columnas una por una): `revision`,
`revisada_por`, `revisada_por_email`, `revisada_en`, `motivo`, `ajustes` (0299),
`entregada_operador_en`, `avisada_oficina_en` (0279) y `pdf_historial` (0306).

Peor que la ausencia: **la colisión de nombre.** `liquidacion_historico.motivo`
existe, pero es `text not null default 'reabrir'` (`0159:179`) — es *por qué se
archivó*. `liquidacion.motivo` es *lo que el contralor escribió al ajustar o
rechazar*, y la base lo exige (`liquidacion_revision_motivo`, 0299:89). Una
consulta que una las dos tablas por nombre de columna lee una cosa creyendo la
otra.

**Escenario, con valores.** VJ-0007, liquidación `revision = 'ajustada'`,
`revisada_por_email = 'contralor@transportesx.mx'`,
`revisada_en = '2026-09-03T16:12Z'`, `motivo = 'el ticket dice 8,000'`,
`ajustes = '[{"gasto_id":"…","concepto":"caseta","monto_anterior":800,"monto_nuevo":8000}]'`.
Dos días después el encargado reabre el viaje desde el panel →
`reabrir_viaje_tx('…tenant…','…viaje…')` → inserta las quince columnas en
`liquidacion_historico` (con `motivo = 'reabrir'`) y hace
`delete from liquidacion where viaje_id = …` (`0159:246-247`). En el histórico
quedan los montos y `pdf_url`; **no queda una sola columna que diga que una
persona firmó ese papel, ni quién, ni qué corrigió a mano.**

**Consecuencia.** La única copia sobreviviente del hecho «alguien firmó esto y
cambió un monto» es la fila de `bitacora_auditoria` que la RPC escribe
(`0306:264-269`) — y esa tabla **sí se purga**, a 365 días
(`purgar_bitacora_auditoria`, 0155:219-238, con mínimo de 365). Pasado un año,
de un viaje reabierto no se puede contestar quién autorizó el ajuste, que es
justamente la pregunta que la revisión humana existe para poder contestar. La
tabla declarada «no es una copia de respaldo: es la constancia» se quedó con la
constancia de la cifra y sin la de la firma.

**Causa raíz probable:** el INSERT de `reabrir_viaje_tx` enumera columnas a mano
y nadie lo revisa cuando `liquidacion` crece; ni la 0279, ni la 0299, ni la 0306
mencionan `liquidacion_historico` en una sola línea.

---

### [BAJO] `NUMERACION-SALTADA.md` afirma que los huecos de numeración son tres; son veintidós
`supabase/migrations/NUMERACION-SALTADA.md` (tabla completa) ·
`supabase/migrations/` (296 archivos, 0001–0318)

El archivo nació en la 25 para cerrar el BAJO reincidente «nada distingue número
saltado de migración perdida», y dice: «**estos tres números no existieron nunca
y no deben reutilizarse**», listando `0277`, `0293`, `0295`.

Contado hoy contra los nombres reales
(`ls *.sql | sed 's/_.*//'` vs `seq -f "%04g" 1 318`), los números ausentes son
**veintidós**:

```
0067 0068 0069 0156 0179 0200 0210 0211 0212 0220 0221 0222 0224
0249 0252 0253 0255 0256 0257 0277 0293 0295
```

**Escenario, con valores.** Alguien audita el despliegue: consulta
`supabase_migrations.schema_migrations` en producción, ve que `0224` no aparece,
abre `NUMERACION-SALTADA.md` para confirmar que fue un salto deliberado y **no
lo encuentra en la tabla**. La conclusión que el documento induce es la
equivocada —«esta migración se perdió del repo»— y la reacción natural es crear
un `0224_*.sql` para «recuperarla», que es exactamente el modo de falla que el
archivo dice cerrar: en una base virgen se aplicaría entre la 0223 y la 0225, y
en producción después de la 0318.

**Consecuencia.** Una marca que cubre 3 de 22 casos se lee como si cubriera los
22. Es deuda barata, pero el archivo se escribió como respuesta a un hallazgo y
no responde la pregunta que dice responder.

**Causa raíz probable:** el documento se redactó desde la lista de huecos que la
auditoría 25 había citado (los tres del tramo reciente), no desde un conteo
sobre el directorio.

---

## Lo que revisé y está bien

**Las 15 migraciones nuevas, abiertas y leídas una por una:**

- **0304** (`llm_costo_fase_transcripcion`) — **DATOS-A1 CERRADO.** Suelta y
  recrea `llm_costo_fase_dominio` con las **siete** fases; `FaseCosto`
  (`costos.ts:41`) tiene esas siete exactas. Y trae el arnés que faltaba:
  `costos_dominio.test.ts:55-56` lee el tipo por regex y lo cruza contra el
  CHECK, así que una fase nueva en TS falla en rojo. **Ninguna fase divergió de
  nuevo**: `grep -rn "'router'" migrations/` devuelve solo el CHECK viejo, el
  nuevo y el dominio de `modelo_rol`.
- **0305** (`15pct_efectivo_forma_pago_efectiva`) — `create or replace` con la
  MISMA firma `(uuid, int, text[])` que 0084/0112/0190, así que Postgres conserva
  el ACL y no sobrecarga; sigue `stable parallel safe` con
  `set search_path = public, pg_catalog`. La sustitución `99 → pagado_forma / NULL`
  no puede dejar un `'99'` vivo, así que el `<> '99'` que la 0190 tenía deja de
  hacer falta sin cambiar el resultado.
- **0306** — ver los tres hallazgos. Lo que sí está bien hecho y era el riesgo
  obvio: el `drop function if exists ...(uuid,uuid,text,text,jsonb,uuid,text)`
  de `:83` tiene **exactamente** la firma de siete de la 0299, así que el octavo
  parámetro no deja dos funciones vivas (la trampa que la propia cabecera cita).
  `pdf_historial` nace `not null default '[]'` con su
  `jsonb_typeof(...) = 'array'`, y `agregar_pdf_historial` usa `||` en SQL en vez
  de leer-modificar-escribir. Revoke + grant a `service_role` en las dos.
- **0307** (`poliza_y_viaje_respetan_rechazada`) — **DATOS-24 CERRADO.**
  `viaje_no_tras_liquidar()` ya lleva `and revision <> 'rechazada'`, el mismo
  criterio que `gasto_no_tras_liquidar()` tiene desde la 0300. Verifiqué que el
  filtro es seguro: `liquidacion.revision` es `text not null default 'pendiente'`
  (0299:56), así que ninguna fila puede evaporar el predicado por NULL. La
  omisión deliberada del escape por GUC está bien razonada: el WHEN del trigger
  (0283:135-150) no incluye `estatus`, que es lo único que la rama 'rechazar'
  toca en `viaje`.
- **0308** (`acreditables_solo_firmadas`) — misma firma, `create or replace`,
  ACL conservado; `revision in ('aprobada','ajustada')` y `revision` es NOT NULL.
- **0309** (`factura_saas_stripe_unica_no_parcial`) — **DATOS-A2 CERRADO.**
  `drop index` + `create unique index` **sin `where`**, exactamente el arreglo
  que la 0176 le dio a `uq_posicion_lectura`. Idempotente (el drop precede). El
  `onConflict: 'stripe_invoice_id'` de `suscripcion.ts:889` ya puede inferir el
  árbitro.
- **0310** (`app_user_operador_tenant_fkey_set_null_columna`) — **DATOS-M3
  CERRADO.** `on delete set null (operador_id)` con la lista. El `validate`
  envuelto en `exception when others → raise notice` no puede tumbar el deploy, y
  el argumento de que ninguna fila que pasaba antes deja de pasar es correcto:
  `SET NULL (operador_id)` anula un subconjunto estricto de lo que anulaba antes.
- **0311** (`agente_definicion_modelo_rol_dominio_espeja_ts`) — **DATOS-B1
  CERRADO** en las dos direcciones. Comprobé el riesgo real de este tipo de
  migración: recrea el CHECK **sin `not valid`**, así que Postgres valida las
  filas existentes al aplicarla — y `grep -rn "chat_ligero"` /`"'router'"` sobre
  `migrations/` confirma que **ninguna fila de `agente_definicion` lleva los dos
  valores retirados** (la 0125 los enumeró solo dentro del CHECK). No puede
  abortar el deploy.
- **0312** y **0315** — el mismo `revoke execute ... from public, anon,
  authenticated` sobre `tenant_perfil_merge(uuid, jsonb, uuid)`, dos veces (dos
  ramas paralelas). La firma coincide con la que crea la 0296:30-34, así que
  ninguna de las dos revienta con «function does not exist»; son idempotentes y
  la duplicación es inocua. **DATOS-B2 CERRADO.**
- **0313** (`incidencia_avisada_jefe`) — columna aditiva nullable, y **sí tiene
  escritor**: `talacha_wa.ts:201` la sella solo tras el envío aceptado, y
  `:121,134` la leen. No es una columna huérfana más.
- **0314** (`viaje_y_cfdi_consolidado_bajo_ve_finanzas`) — `drop policy if
  exists` sobre el nombre REAL (`tenant_data_select` en `viaje`, `tenant_data` en
  `cfdi_consolidado_linea`), que es la parte que un primer intento erró según su
  propia cabecera: dos policies permisivas se combinan con OR y la vieja habría
  seguido abriendo todo. Tras la 0314 `viaje` queda con una sola policy, de
  SELECT, y sin policy de INSERT/UPDATE — con RLS activa eso es negar por
  omisión, que es lo correcto.
- **0316 → 0317** (`gastos_fiscales_agregados_*`) — la 0316 **sí perdió**
  `pagado`/`pagado_forma` (0282) y el `upper(trim(...))` del emisor (0192) al
  partir de una copia vieja, y la 0317 los restaura literalmente
  (`0317:74-75,175`). Comprobé que la pérdida es **transitoria y no llega a
  producción sola**: la 0317 es la que dropea la firma de 7 y crea la de 13, van
  en el mismo despliegue, y después queda **una sola** función (sin overload
  huérfano). Verifiqué también que las trece columnas que la 0317 estrena existen
  de verdad —`tipo_comprobante`, `cfdi_esquema_alterno`,
  `complemento_hidrocarburos`, `xml_verificado`, `rfc_receptor` (0004/0006)— y
  que `leerCelda` (`fiscal.ts:1345-1400`) exige las seis banderas nuevas como
  booleanos obligatorios, así que una base sin la 0317 falla ruidoso en vez de
  devolver ceros. El `left join liquidacion ... on l.viaje_id = g.viaje_id` sin
  `tenant_id` no filtra de más: los dos lados apuntan por FK al mismo `viaje`, que
  pertenece a un solo tenant.
- **0318** (`mcp_oauth_usuario_vigente_respeta_activo`) — `create or replace`,
  misma firma, `security invoker`, `set search_path`, revoke + grant. El `and
  activo` es seguro porque `app_user.activo` es `boolean not null default true`
  (0294:45), no un nullable de tres estados.

**Otras comprobaciones que hice y salieron limpias:**

- **Ninguna tabla del esquema se quedó sin RLS.** Crucé las 146 tablas creadas en
  `migrations/` contra todos los `enable row level security`, incluidos los dos
  que corren dentro de un `foreach` (0001:106-118 y 0047:155-164, que mi primer
  barrido literal no veía). Diferencia: cero.
- **La batería no tiene números de bloque repetidos** (235 títulos,
  `sort | uniq -d` vacío), y **las 15 migraciones nuevas tienen bloque o
  exención con razón escrita** — `migraciones_verificadas.test.ts` pasa (4/4,
  corrido). 0316/0317/0308/0313 van por `EXENTAS` con argumento; 0318 entra al
  título del bloque 212; 0305 y 0311 por `EXENTAS`.
- **La renumeración por colisión se hizo bien.** `7127752` (0316→0318) y
  `f2f1486` (0305→0308) renombraron el archivo Y sus referencias cruzadas
  (`EXENTAS`, bloque 212, comentarios en TS); no quedó ningún número duplicado ni
  una referencia colgante. La 0317 depende de que la 0316 se aplique primero
  (dropea la firma que aquélla deja) y el orden numérico lo garantiza.
- **DATOS-M1 y DATOS-M2 cerrados de verdad, no en el mensaje.** `5ff4155` no
  rellenó `prompt_ref`: corrigió al **consumidor** —`backoffice.ts` ahora solo
  exige `prompt_ref` cuando `modeloRol` no es null—, que es la lectura correcta
  del dato. `3488b26` cambió el sub-chequeo (c) del bloque 249 de cinco frases
  ajenas contra los nueve, a un emparejamiento **posicional** id↔frase propia:
  ahora sí puede fallar.
- **`liquidacion.diferencias` sí tiene guardia de forma** —
  `liquidacion_diferencias_arreglo` (0158:580), con su comprobación previa de
  filas malas. Era mi candidato a hallazgo por la línea `0306:231`
  (`coalesce(p_recalculo -> 'diferencias', ...)`) y está cubierto: un objeto o un
  string rebota con 23514 en vez de reventar `jsonb_array_elements` en el panel.
- **`estatus` no puede quedar en NULL por la 0306**: `liquidacion.estatus` es
  `text not null` (0001:74), así que un `p_recalculo` sin esa llave rebota con
  23502, ruidoso, y su dominio sigue puesto (`liquidacion_estatus_dominio`,
  0025:126).
- **Los pisos y unicidades del dinero siguen donde estaban**:
  `liquidacion_viaje_uidx` (0005:9, una liquidación por viaje — que es lo que de
  verdad hace correcto el LEFT JOIN de la 0316/0317, no el trigger que su
  comentario invoca), `uq_gasto_cfdi_uuid`, `uq_gasto_img_hash`,
  `uq_gasto_wa_message_id`, `uq_cfdi_pago_docto` + su forma en minúsculas
  (0283:187-194). **El caso de manual —el mismo CFDI liquidándose dos veces—
  sigue cerrado.**
- **El WHEN de `trg_gasto_no_tras_liquidar` (0283:100-127) sí incluye
  `sub_total`, `iva_traslado` e `ieps_traslado`**: la base gravable de un
  comprobante ya liquidado no se puede editar por fuera de la RPC. Por eso el
  primer hallazgo es sobre `monto`, y solo sobre `monto`.

## Lo que NO alcancé a revisar

- **No hay Postgres aquí.** Nada de lo anterior se aplicó ni se corrió: todo sale
  de leer el SQL, sus llamadores y el historial de cada fila. Donde más pesa:
  (a) no ejecuté el bloque 251 ni ningún otro de `verificaciones.sql`, así que
  los estados que describo como «entra a la base» son deducción de las
  restricciones vivas, no observación; (b) no sé si el `validate constraint` de
  la 0310 pasó o cayó en su `raise notice` sobre los datos reales —el aviso solo
  se ve en el log del despliegue—; (c) no comprobé contra `pg_policies` que la
  0314 dejara `viaje` con una sola policy, solo contra el texto de las
  migraciones (la propia 0314 documenta que ese es justo el punto donde el texto
  engaña).
- **Reversibilidad: sigue sin evaluarse de forma sistemática, y ahora pesa más.**
  Ninguna de las 15 trae bloque de reversa. Las reversibles reaplicando el cuerpo
  anterior son 0304, 0305, 0307, 0308, 0309, 0310, 0311, 0318. **Las que no lo
  son limpiamente**: la 0306 (revertir a la firma de siete exige dropear la de
  ocho y reaplicar el cuerpo de la 0299, y `pdf_historial` quedaría colgada), y
  la 0317 (su `drop function` de la firma de 7 borra la versión de la 0316, que
  ya no existe en ningún archivo posterior). No reconstruí el `down` de las 296.
- **`src/types/likida.ts` lo crucé completo contra `gasto`, `liquidacion`,
  `viaje` y `operador`; no barrí las ~140 tablas restantes** buscando más pares
  tipo↔columna desalineados. Sí verifiqué que los cuatro dominios con prueba
  (`FaseCosto`, `ModelRole`, `ConceptoGasto`, `EstadoSat`) y
  `evento_seguridad.origen/tipo/severidad` empatan al valor; el resto no.
- **RLS: solo comprobé la propiedad estructural** (ninguna tabla sin
  `enable row level security`) y las dos policies que la 0314 tocó. No releí las
  ~140 policies una por una ni volví a validar las de la 24 (0292, 0294), que doy
  por vigentes sin verificarlas línea a línea.
- **`geocerca`, `terminal`, `portal_credencial`, `invitacion`** siguen sin
  escritor y no cambiaron en este tramo; no las audité.
- **No corrí la suite completa.** Solo `migraciones_verificadas.test.ts` (4/4).
  Ninguna conclusión de arriba depende de una prueba.
