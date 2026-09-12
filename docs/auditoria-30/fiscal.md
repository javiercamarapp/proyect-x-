# Cumplimiento fiscal — auditoría 30

**Nota: 3/10** (antes 4). Razón del movimiento: **mirada más profunda — la nota
anterior estaba inflada**. El 4 de la 29 se sostuvo sobre una mitigación escrita
con todas sus letras: «lo que sí bajó es el **radio**: de "cualquier cliente
nuevo, en la pantalla de alta" a "la consola del superadmin"»
(`docs/auditoria-29/fiscal.md:255-258`). **Esa mitigación es falsa hoy y ya lo
era entonces**: `actualizarFacilidad15` tiene otros dos llamadores, y los dos son
del cliente — `/dashboard/onboarding` y la entrevista por WhatsApp. El cotejo que
`8fc2fa7` añadió sí cierra la ruta de `/admin/flotas` (y su prueba se pone roja
si lo reviertes), pero en las dos rutas del cliente **el valor que decide ya se
escribió una línea antes de que el cotejo corra**, y el `throw` del cotejo no lo
deshace. El producto sigue en el tramo del ancla *«3 o menos si imprime una cifra
fiscal equivocada»*, con el radio de vuelta en el cliente.

Lo que sí cerró de verdad esta ventana, y lo cuento antes de los hallazgos porque
es trabajo real: `0355` mata el reincidente «el panel del contador cuenta las
copias que el PDF descarta» (el camino agregado entero pasa por la RPC, y ahora
deduplica); `0352` + `facturacion_escritura.ts` abren la representación de la
retención del 4 % en la base y en el validador; y el reintento del consolidado
ECC (`d0db998`) **no duplica comprobantes** — lo intenté romper y no pude.

**El riesgo mayor del rubro, hoy:** el cotejo contra la clave del SAT se
instaló *después* de la escritura que debía vigilar, así que en la pantalla de
onboarding del cliente la declaración contradictoria se guarda, se rechaza en
pantalla, y el motor imprime la deducción igual.

| Severidad | # | de los cuales |
|---|---|---|
| CRÍTICO | 2 | 2 REINCIDENTES (FIS-C1 en su 3ª forma; el segundo anotado ya en la 29) |
| ALTO | 3 | 1 REINCIDENTE · 1 MUTADO · 1 nuevo |
| MEDIO | 5 | 3 REINCIDENTES · 2 nuevos |
| BAJO | 3 | 2 REINCIDENTES · 1 nuevo |

Lo marcado *(medido)* se corrió con `parseOnboarding`, `declararOnboarding`,
`facilidad15Declarada`, `facilidad15Vigente` y **`cuadrarViaje` reales**, desde
un `vitest.config.mjs` en el scratchpad con `resolve.alias` a
`/home/user/cuadra/src`. **Cero archivos del repo tocados** salvo este
entregable.

---

## Los tres focos del encargo, contestados primero

### (a) El CRÍTICO de la 29: **no se cerró; mutó por tercera vez**

`8fc2fa7` dice cerrar FIS-C1. Abrí los cuatro archivos y la prueba.

**Lo que sí hizo.** `src/lib/likida/repo.ts:1616-1632` añade el cotejo: si
`reg === true`, lee `tenant.regimen_fiscal` y lanza `DatoInvalido` cuando
`regimenElegiblePorClave(clave) === false`; falla cerrado si la lectura da error
(`:1624`). `src/lib/likida/perfil/preguntas.ts:362-372` centraliza
`REGIMENES_ELEGIBLES_15 = ['624','612']` y `administracion.ts` deriva de ahí en
vez de su copia. **¿La prueba se pone roja si reviertes el arreglo?** Sí. Corrí
`src/lib/likida/facilidad15_regimen_cotejado.test.ts` → **8 pasan**; su primer
caso (`:69-78`) no se conforma con el mensaje, afirma
`expect(rpc).not.toHaveBeenCalled()` — quitar el bloque `if (reg === true)` hace
que `tenant_perfil_merge` corra y el caso falla por las dos aserciones. Prueba
honesta, no decorativa.

**Lo que no hizo, y es el hallazgo FIS-C1 de abajo.** El commit cerró el
llamador de `/admin/flotas` (donde `actualizarFacilidad15` es la ÚNICA
escritura). En los otros dos llamadores —los del cliente— la escritura
autoritativa la hace `guardarPerfilPatch` **una línea antes** del cotejo.

### (b) Las tres migraciones fiscales, cada una contra su test SQL

| Migración | ¿Hay test? | ¿Contiene el caso que hace DIVERGIR la vieja de la nueva? |
|---|---|---|
| `0349_combustible_15_sin_copias.sql` | `supabase/tests/0349_combustible_15_sin_copias.sql` | **SÍ.** `:17-21` mete dos filas de diésel de $300 en efectivo con `folio` `'0059'` y `'59'` y el **mismo `folio_norm='59'`**. La función vieja (0345) da `total=3600, efectivo=600`; la nueva `3300/300`, y el test lo escribe como rojo esperado en su comentario `:25-26`. Es exactamente el `WHERE orden_copia = 1` nuevo. Además fija idempotencia (`:36-39`) y que leer no muta `gasto` (`:42-46`). El propio test declara con honestidad que el camino por `(cfdi_uuid, cfdi_orden)` **no se puede ejercitar** porque `uq_gasto_cfdi_uuid` ya lo prohíbe — cierto, y bien dicho. |
| `0352_factura_retencion_iva.sql` | `supabase/tests/0352_factura_retencion_iva.sql` | **SÍ.** `:14-15` inserta `subtotal 10000, iva 1600, retencion_iva 400, total 11200`, que el CHECK viejo (`abs(total-(subtotal+iva))<=0.01`) rechazaba. Y cubre las dos direcciones: total que ignora la retención (`:24-30`) y retención negativa (`:32-38`), las dos esperando `check_violation`. |
| `0355_gastos_fiscales_sin_copias.sql` | **NO EXISTE.** `ls supabase/tests/` llega hasta `0354_cierre_insumos_hash_v2.sql`. | No hay ni camino feliz. Ver FIS-A3. |

Contra la ficha: las tres se justifican por `normas/rfa-2026-2.9.yaml`
(`verificado_fuente_primaria`) en el caso del cubo del 15 %, y por
`normas/rliva-3-fr-II.yaml` (`verificado_fuente_primaria`) en el de la retención.
Ninguna de las tres contradice el texto que transcribo abajo. Las dos que sí
tienen problema lo tienen por **alcance** y por **falta de captura**, no por la
cifra.

### (c) `d0db998` / `e2038a5`: ¿el reintento duplica comprobantes? **No. Intenté romperlo y no pude.**

Escribo la refutación porque el encargo pedía dictaminar, no confirmar la
sospecha:

- `decidirCruce` (`src/lib/likida/sat_descarga/cruce.ts:90-121`) **sí es puro
  respecto de `fondo`** en la rama que importa: las reglas 0, 1 y 1-bis
  (`tipoComprobante==='E'`, padrón de monederos, `>1` línea `ecc12`) devuelven
  antes de tocar `gastos`. La afirmación del comentario de `ciclo.ts:315-320` se
  sostiene. Y `ciclo.ts:353` (`if (yaDescargado) continue;`) deja los demás
  destinos con el dedup de siempre.
- `guardarYConciliarConsolidado` **no crea `gasto`**: liga los que ya existen
  (`ligarLineaAGasto`). No hay camino por el que un reintento produzca un
  comprobante nuevo.
- La salida temprana de idempotencia (`intake/consolidado.ts:440-443`) devuelve
  el resumen sin re-correr el JOIN si ya hay líneas, y la reanudación
  (`:457-483`) respeta los `gasto` ya sellados por `cfdi_orden`.
- El `upsert` de líneas (`:527-529`, `onConflict: 'cfdi_xml_id,indice'`) se apoya
  en un `unique (cfdi_xml_id, indice)` que existe de verdad
  (`supabase/migrations/0076_cfdi_consolidado.sql:66`) y se manda en **una sola
  sentencia**, así que ni siquiera hay escritura parcial de líneas que reabra la
  ventana.

Lo que sí encontré en ese camino es otra cosa, y es FIS-M2: la paginación por
cursor de `e2038a5` **no es inmune a inserciones**, aunque su commit lo afirme.

---

## Hallazgos

### [CRÍTICO] FIS-C1 — el cotejo contra la clave del SAT corre DESPUÉS de la escritura que vigila: en `/dashboard/onboarding` y en la entrevista de WhatsApp la declaración contradictoria queda guardada, se rechaza en pantalla, y el motor deduce igual (REINCIDENTE, 3ª forma)

`src/app/dashboard/onboarding/page.tsx:66-74`, textual:

```tsx
const patch = declararOnboarding(parsed.datos);
await guardarPerfilPatch(ses.tenantId, patch, ses.userId);   // :67  ← LA FUENTE QUE DECIDE
const f15 = facilidad15Declarada(patch);
if (f15) {
  await actualizarFacilidad15(ses.tenantId, f15.dedicacionExclusivaCarga, f15.regimenElegible, ses.userId);  // :70  ← EL COTEJO
}
} catch (e) {
return { error: mensajeParaPantalla(e, 'guardar el perfil') };  // :73  ← se traga el throw; nada se deshace
```

· mismo orden, mismo defecto, en el camino conversacional:
`src/lib/likida/perfil/entrevista-aplicar.ts:78` (`await guardarPerfilPatch(...)`)
y `:82` (`await actualizarFacilidad15(...)`).
· el cotejo que se salta: `src/lib/likida/repo.ts:1616-1632`.
· por qué el perfil decide solo: `src/lib/likida/perfil/preguntas.ts:366-367`
(`facilidad15Vigente`: el perfil gana, `tenant.config` es el `else`) y
`src/lib/likida/cuadre/desde_db.ts:110-113` (→ `facilidad15`).

**Norma** — `normas/rfa-2026-2.9.yaml`, **`verificado_fuente_primaria`**, líneas
9-12, literal:

> «Los contribuyentes personas físicas o morales, dedicados exclusivamente al
> autotransporte terrestre de carga federal, **que tributen conforme al Título
> II, Capítulo VII o Título IV, Capítulo II, Sección I de la Ley del ISR**,
> considerarán cumplida la obligación establecida en el artículo 27, fracción
> III, segundo párrafo de la Ley del ISR…»

y `normas/lisr-72-73.yaml`, **`verificado_fuente_primaria`**, art. 72 1er
párrafo: «Se consideran **coordinados**, a las personas morales que administran y
operan activos fijos … relacionados directamente con la actividad del
autotransporte …». Título II Cap. VII = clave `c_RegimenFiscal` **624**; el
Título II a secas es **601** y no entra. La condición es una clave, no una
opinión.

**Escenario, con pesos** *(medido)*. Flota S.A. de C.V., `tenant.regimen_fiscal =
'601'` (lo escribió `crearFlota`, `administracion.ts:218`). El dueño
—`flota_admin`, sin pasar por Javier— abre `/dashboard/onboarding` y en «Régimen
fiscal (clave SAT c_RegimenFiscal)» elige **624** (se equivocó, o su contador le
dijo que «somos coordinados»), y «Dedicación exclusiva» = **Sí**. Ejercicio 2026:
combustible $1,000,000, de los cuales $140,000 pagados con medios que la LISR
27-III no admite. Un CFDI de diésel de **$11,600** (SubTotal $10,000 + IVA
$1,600), `FormaPago '01'`, XML verificado.

1. `:67` escribe el perfil. Salida **medida** de `declararOnboarding`:
   `{"dedicacionExclusivaCarga":{"valor":true,"procedencia":"declarado"},"regimenElegible":{"valor":true,"procedencia":"declarado"},"regimenSat":{"valor":"624","procedencia":"declarado"}}`
2. `:70` coteja contra `tenant.regimen_fiscal='601'` y **lanza**. El dueño ve en
   pantalla «La flota está registrada con el régimen fiscal 601 … esta
   declaración imprimiría en el PDF una deducción que la norma le niega» y se va
   creyendo que no se guardó nada.
3. Pero se guardó. **Medido** con los helpers reales:
   `facilidad15Vigente(perfil, config{dedicacion:false, regimenElegible:false})`
   → `{"dedicacionExclusivaCarga":true,"regimenElegible":true}`. El `false`
   derivado de la clave 601 **no se consulta**.
4. `desde_db.ts:111-113` → `facilidad15: true`.

Los dos veredictos del motor sobre el MISMO CFDI, **medidos con `cuadrarViaje`
real**:

| | 601 real (`facilidad15:false`) | tras el onboarding rechazado (`true`) |
|---|---|---|
| Deducible para ISR | **$0.00** | **$11,600.00** |
| No deducible | **$11,600.00** | $0.00 |
| IVA acreditable | **$0.00** | **$1,600.00** |
| Diferencia emitida | `efectivo_no_elegible` | `combustible_efectivo_dentro15` |

y la frase que se imprime, verbatim de la corrida:

> «Combustible pagado en EFECTIVO — deducible por la facilidad del 15 % (**RFA
> 2026 regla 2.9**): el ejercicio lleva $140,000.00 de $1,000,000.00 de
> combustible pagado con medios que la LISR 27-III no admite (14 % del total,
> tope 15 %). No acredita IEPS.»

**Consecuencia.** Sobre los $140,000 del ejercicio: **$140,000 de deducción** que
la RFA 2.9 le niega a un 601 (~$42,000 de ISR a la tasa del art. 9) y **$22,400
de IVA acreditable**. Y peor que en la 29: el usuario **vio un error en
pantalla**, así que ni siquiera queda el rastro de una concesión consciente — el
producto le dijo «no» y le concedió «sí». El radio vuelve a ser el que la 28
describió: cualquier cliente, en su propia pantalla, sin superadmin de por medio.

**Me refuté antes de escribirlo.** Busqué si `guardarPerfilPatch` fuera
transaccional con lo que sigue o si el `catch` revirtiera: `repo.ts:127-140` es
una fusión vía RPC `tenant_perfil_merge`, commiteada al volver; el `catch` de
`page.tsx:72` solo pinta texto. Y busqué si `facilidad15Vigente` exigiera que el
config concuerde: `preguntas.ts:366-367` dice lo contrario, el perfil gana y el
config es el `else`. El hallazgo se sostiene.

**Causa raíz probable:** el guardia se puso en `actualizarFacilidad15` —la
función que en `/admin/flotas` ES la escritura— y se invocó en los otros dos
llamadores DESPUÉS de que ellos ya escribieron la misma decisión por su cuenta;
la validación quedó a un lado del camino del dato, no dentro de él.

---

### [CRÍTICO] FIS-C2 — el cotejo es de una sola dirección y de un solo momento: cambiar la clave del SAT después NO recalcula nada, y el propio cliente puede cambiarla desde `/dashboard/suscripcion` (REINCIDENTE de la 29)

`src/lib/saas/fiscal.ts:222-233`, la función completa:

```ts
export async function guardarDatosFiscales(tenantId: string, d: DatosFiscalesCapturados): Promise<void> {
  const fila = validarDatosFiscales(d);
  const { error } = await supabaseAdmin().from('tenant').update(fila).eq('id', tenantId);
  if (error) throw new Error(`guardarDatosFiscales: ${error.message}`);
}
```

`fila` incluye `regimen_fiscal` (`:207`). No hay una línea que toque
`tenant.perfil` ni `tenant.config.facilidadCombustibleEfectivo`. Llamadores de
producción: `src/app/dashboard/suscripcion/page.tsx:202` (pantalla del
**cliente**) y `src/lib/likida/perfil/entrevista-aplicar.ts:140` (la entrevista
por WhatsApp, dentro de `nutrirDesdeHechos`). `REGIMENES`
(`src/lib/saas/fiscal.ts:24-31`) ofrece `601, 603, 612, 621, 624, 626`, así que
el salto 624→601 es un ítem de un `<select>`.

**Norma** — la misma `normas/rfa-2026-2.9.yaml`
(**`verificado_fuente_primaria`**, líneas 9-12) transcrita arriba: la
elegibilidad es un hecho del régimen, no un estado que se declare una vez y
sobreviva al cambio de régimen.

**Escenario, con pesos.** Flota dada de alta como **624**. El onboarding declara
dedicación Sí + clave 624 → `perfil.regimenElegible = {valor:true, procedencia:
'declarado'}`, y el cotejo de `repo.ts:1626` **pasa legítimamente**. Seis meses
después el contador la reestructura y la flota queda **601**; el dueño entra a
`/dashboard/suscripcion`, corrige «Régimen fiscal» a **601** para que le facturen
bien la suscripción, y guarda. A partir de ahí:

- `tenant.regimen_fiscal = '601'` — el dato que viaja al CFDI de la mensualidad.
- `tenant.perfil.regimenElegible` sigue en `true` — el dato que decide el motor.
- `facilidad15Vigente` → `{true,true}` *(medido: el perfil gana sobre un config
  contrario)* → `facilidad15: true`.
- Cada CFDI de diésel en efectivo del ejercicio sigue saliendo deducible: sobre
  los mismos $140,000 anuales, **$140,000 de deducción y $22,400 de IVA
  acreditable** que a un 601 no le corresponden, citando la RFA 2.9 en verde.

**Y la variante que apunta al otro lado**, en el mismo archivo: en
`entrevista-aplicar.ts` el cotejo de `:82` corre **antes** de que
`nutrirDesdeHechos` escriba la clave nueva (`:140`), así que se coteja contra la
clave **vieja**. Una flota que en la entrevista declara honestamente «soy 624»
teniendo `tenant.regimen_fiscal='601'` recibe un rechazo por una clave que la
misma conversación está a punto de corregir — y el perfil ya quedó escrito de
todas formas por `:78`.

**Consecuencia.** El `tenant` afirma dos cosas a la vez y nadie las compara:
`regimen_fiscal='601'` en el CFDI que Likida le emite al cliente, y
`perfil.regimenElegible=true` en la liquidación que el cliente le enseña a su
contador. El contralor cruza uno contra otro en la primera revisión.

**Causa raíz probable:** la elegibilidad se guarda como estado declarado en vez
de derivarse en lectura de `tenant.regimen_fiscal`; el cotejo se instaló en el
escritor de la declaración y no en el escritor de la clave.

---

### [ALTO] FIS-A1 — la «fuente única» del 15 % sigue siendo un parámetro OPCIONAL y los dos paneles del cliente siguen sin pasarlo: el panel del contador juzga el diésel en efectivo con el legado mientras el motor lo juzga con el perfil (REINCIDENTE de la 29, sin un solo carácter de cambio)

`src/lib/likida/fiscal.ts:577` — `export function opcionesDe(cfg: LikidaConfig, perfilCrudo?: unknown)`.
Llamadores medidos hoy con `grep`, idénticos a los de la 29:

| Llamador | ¿pasa el perfil? |
|---|---|
| `src/app/dashboard/contador/inicio-contador.tsx:121`, `:126-128` | **NO** (`opcionesDe(cfg)`) |
| `src/app/dashboard/inicio-contenido.tsx:161`, `:166-168` | **NO** (`opcionesDe(cfg)`) |
| `src/app/dashboard/contador/inicio-contador.tsx:137` (`opcionesFiscalesDelPeriodo`) | **SÍ** — en la MISMA página |
| `chat-tools.ts:152`, `mcp/herramientas/dinero.ts:165`, `fiscal.ts:1650`/`:1716` | sí |

**Norma** — `normas/rfa-2026-2.9.yaml` (**`verificado_fuente_primaria`**, líneas
13-17) más la regla de la casa que este rubro custodia: la misma cifra fiscal no
puede leerse distinto en dos pantallas.

**Escenario, con pesos** — el de la 29, reescrito con los valores de hoy: flota
sin `regimenFiscal` capturado al alta (es opcional, `administracion.ts:112`), el
dueño declara honestamente dedicación=Sí y clave **601** en onboarding →
`perfil = {dedicacion:true, regimenElegible:false}`. Ejercicio con $140,000 de
diésel en efectivo y $22,400 de IVA trasladado.

- **Motor y PDF**: `facilidad15 = true && false = false` → $140,000 **no
  deducibles**, IVA acreditable **$0**.
- **`/dashboard/contador`, renglón de arriba** (`resumirPerdidas` con
  `opcionesDe(cfg)` → `elegible15 = undefined`): causa `combustible_efectivo`,
  cuya ficha (`fiscal.ts:693-698`) reza «**Dentro del 15 % sigue siendo
  deducible**», y el monto entra como **en riesgo**, no como perdido.
- **Dos centímetros abajo, en la MISMA página** (`BloqueDesglose`, alimentado por
  `:137`, que sí lee el perfil): esos mismos $140,000 con **$22,400 de IVA NO
  acreditable**.

**Consecuencia.** El comprador lee dos veredictos contrarios sobre la misma cifra
en la misma pantalla, el mismo día en que el PDF dijo un tercero. Falla
silenciosa: el KPI de arriba suma `montoEnRiesgo + montoPerdido` y el agregado
tapa la diferencia.

**Causa raíz probable:** la fuente única entró como parámetro opcional en vez de
dependencia obligatoria, y ningún guardia cuenta llamadores de `opcionesDe` sin
perfil.

---

### [ALTO] FIS-A2 — la retención del 4 % ya cabe en la base y en el validador, pero **ningún formulario la teclea**, y la ayuda en pantalla afirma lo contrario de lo que la ley obliga: cada factura a persona moral nace con un saldo fantasma del 4 % que la cobranza va a reclamar (MUTADO desde FIS-M3, abierto en las rondas 25-29)

`src/app/dashboard/facturacion/forma.tsx:159-170` — el formulario completo tiene
`subtotal` y `iva`, y **no tiene `retencion`**; `src/app/dashboard/facturacion/page.tsx:118-119`
lee solo esos dos de la `FormData`, así que `c.retencion` llega siempre
`undefined` y `facturacion_escritura.ts:158` lo resuelve a `0`. La ayuda impresa,
`forma.tsx:168-169`, textual:

> «Tal como quedó en el CFDI. **El total lo calculamos nosotros: subtotal + IVA,
> sin oportunidad de descuadre.** Si la factura es tasa 0 % o exenta, teclea 0.»

Contra `facturacion_escritura.ts:161` (`const total = Math.round((subtotal + iva
- retencion) * 100) / 100`) y contra lo que **el propio Likida timbra**:
`src/lib/likida/carta_porte_cfdi.ts:200` (`const ret = esMoral ? dinero(sub *
0.04) : null`), `:202` (`const total = dinero(sub + iva - (ret ?? 0))`) y
`src/app/dashboard/timbrado/[viajeId]/timbrar.tsx:236`, que imprime en pantalla
«− retención IVA 4 % … (receptor persona moral, LIVA 1-A II c)».

**Norma** — `normas/rliva-3-fr-II.yaml`, **`verificado_fuente_primaria`**
(diputados.gob.mx, verificada 3-sep-2026), líneas 14-17, literal:

> «II. **La retención se hará por el 4% del valor de la contraprestación pagada
> efectivamente, cuando reciban los servicios de autotransporte terrestre de
> bienes** que sean considerados como tales en los términos de las leyes de la
> materia.»

**Escenario, con pesos.** Flota que le factura a un cliente persona moral (RFC de
12 caracteres): flete **$10,000**, IVA **$1,600**, retención obligatoria
**$400**, total del CFDI **$11,200** — que es exactamente lo que el XML de
`carta_porte_cfdi.ts:234` declara (`TasaOCuota="0.040000" Importe="400"`). El
contador captura esa factura en `/dashboard/facturacion`: teclea 10,000 y 1,600
porque no hay dónde poner los 400, y Likida guarda `total = 11,600`
(`facturacion_escritura.ts:394` manda `retencion_iva: 0`).

- La vista `factura_saldo` (`supabase/migrations/0161_fechas_locales.sql:111`,
  `f.total - coalesce(sum(p.monto),0) as saldo`) deja **$400 de saldo
  permanente** en cuanto el cliente paga los $11,200 que le corresponden.
- `:114-118` la marca **`vencida`** apenas pasa `vence_en` (el umbral es `> 0.01`).
- `src/lib/likida/auditor_cobranza.ts:375` redacta entonces: «El cliente abonó
  $11,200.00 y quedan $400.00 por cobrar … Un pago parcial sin seguimiento se
  vuelve el saldo que nadie reclama.» — y se lo manda al cliente.
- Una flota con 50 facturas al mes: **$20,000 mensuales de cartera inventada** y
  50 recordatorios de cobranza pidiendo dinero que el cliente retuvo y enteró al
  SAT.

**Por qué es ALTO y no MEDIO como en la 29.** En la 29 era una limitación de
esquema («`factura_emitida` NO PUEDE representar la retención»): nada afirmaba lo
contrario. Hoy el esquema puede, el validador puede, **y la pantalla afirma por
escrito que el total es subtotal + IVA «sin oportunidad de descuadre»** — una
afirmación que la norma desmiente para todo receptor persona moral. Pasó de
carencia a rótulo falso, que es lo que este rubro no perdona.

**Causa raíz probable:** `0352` y el validador se hicieron en el mismo lote y el
formulario no; el comentario de `facturacion_escritura.ts:156-157` («ningún
formulario la teclea todavía») lo dice sin tratarlo como bloqueante.

---

### [ALTO] FIS-A3 — `0355` reescribe la RPC que alimenta TODO el panel del contador y es la única de las tres migraciones fiscales **sin un solo test SQL**

`supabase/migrations/0355_gastos_fiscales_sin_copias.sql:104-122` mete dos CTEs
nuevos (`marcadas` con `row_number()`, `base` con `where orden_copia = 1`) en el
camino de `gastos_fiscales_agregados_tenant`, la función de **26 dimensiones** de
la que sale todo `/dashboard/contador` (`src/lib/likida/fiscal.ts:1652`,
`getGastosFiscales` → `resumirFiscal` / `resumirPerdidas`). `ls supabase/tests/`
llega hasta `0354_cierre_insumos_hash_v2.sql`: **no hay `0355_*.sql`**. Ni el
caso que diverge, ni el camino feliz, ni una afirmación de que la forma de salida
no cambió.

**Norma** — `normas/rfa-2026-2.9.yaml` (**`verificado_fuente_primaria`**) en lo
que toca al 15 %, y la regla de la casa: *una cifra fiscal que se lee distinto en
dos pantallas se lee como dos cálculos*. Lo que falta aquí no es la norma: es la
prueba de que el cambio hace lo que su comentario promete.

**Escenario, con pesos.** El `unaccent(lower(bc.concepto))` de `:110` depende de
la extensión `unaccent` en el esquema `public`. `0349:37` la crea explícitamente
(`create extension if not exists unaccent with schema public`) y explica por qué
(`:27-36`: una base virgen de CI no la trae, y `search_path` está fijado a
`public, pg_catalog`). **`0355` usa `unaccent` y NO repite ese `create
extension`.** Aplicada sobre una base donde `0349` no corrió antes —o donde la
extensión vive en `extensions`, el default de Supabase que el propio comentario
de `0349:32-34` menciona— la función se crea igual (SQL `stable` no valida el
cuerpo hasta ejecutarse) y **revienta en la primera llamada**: el panel del
contador entero cae en `getGastosFiscales` (`fiscal.ts:1673`, `throw`). Sin test
SQL, eso se descubre en producción, no en CI. Con test, se descubriría al
aplicar.

Y sin test tampoco hay nada que fije el caso que motiva la migración: dos filas
que coinciden en las 26 dimensiones y en `(folio_norm, monto)` deben colapsar a
`n=1`, no a `n=2`. Sobre dos fotos del mismo ticket de diésel de **$11,600**, la
función vieja imprime en el panel «2 comprobantes · $23,200.00» y la nueva «1 ·
$11,600.00»; nada en el repo prueba cuál de las dos está corriendo en la base.

**Por qué es ALTO.** El MAPA de esta ronda lo puso como el modo de falla
declarado del rubro: «un `CREATE OR REPLACE FUNCTION` que cambia un `WHERE` y un
test que no ejercita ese `WHERE`». Aquí no hay test que ejercitar.

**Causa raíz probable:** `0349` y `0355` son el mismo criterio en dos lugares;
el segundo se escribió confiando en que el test del primero cubre el criterio, y
el test del primero prueba OTRA función.

---

### [MEDIO] FIS-M1 — `0349` y `0355` dicen portar «el criterio EXACTO» de `copiasDeComprobante`, pero el original deduplica **dentro de un viaje** y el portado deduplica **dentro del tenant y del ejercicio**

`supabase/migrations/0349_combustible_15_sin_copias.sql:7-8`, textual: «Mismo
criterio **EXACTO** que `copiasDeComprobante` (src/lib/likida/cuadre/
engine.ts:514-564), portado a SQL con `row_number() over (partition by ...)`».
Igual en `0355:100-103`.

El original: `src/lib/likida/cuadre/engine.ts:514` recibe `gastos: Gasto[]`, y
**todos** sus llamadores de producción le pasan los gastos de **un** viaje o de
**una** liquidación — `engine.ts:674` (`input.gastos`), `liquidacion/pdf.ts:452`,
`liquidacion/omitidos.ts:93`, `analytics.ts:1624`, `tools.ts:145`,
`consulta_chofer.ts:199`, `processor.ts:3296`/`:3908`,
`api/export/poliza/route.ts:119`/`:179` (por fila de liquidación). El portado:
`0349:46-55` particiona sobre **todo el `gasto` del tenant del año**, y `0355:96-98`
sobre **todo el `gasto` del tenant en `p_desde..p_hasta`**. Ni uno ni otro
particiona por `viaje_id`.

**Norma** — `normas/rfa-2026-2.9.yaml`, **`verificado_fuente_primaria`**, líneas
13-17, literal:

> «…siempre que estos no excedan **el 15 por ciento del total de los pagos
> efectuados por consumo de combustible** para realizar su actividad.»

El numerador y el denominador de ese 15 % son los que `0349` calcula. Un criterio
de copia más ancho que el del motor mueve los dos.

**Escenario, con pesos.** Flota 624 que carga diésel de contado en bomba. Dos
viajes distintos, dos estaciones distintas, dos tickets sin CFDI de **$1,000.00**
cada uno («ponme mil de diésel», el importe redondo es la norma en bomba), con
folios `0042` y `42` — que `folio_norm` normaliza al mismo `42`. Para el motor
son dos gastos de dos viajes: cada liquidación ve un solo ticket y ninguno es
copia. Para `0349:63` son la **misma** partición
`(unaccent(lower('diesel')), '42', 1000)` y la segunda sale con `orden_copia = 2`
→ **no se cuenta**.

Con 20 coincidencias así en el ejercicio (una cada 18 días, en una flota que
carga a diario): el ejercicio real es total **$1,000,000** / efectivo
**$150,000** = **15.00 %**, justo en el tope. Lo que `sumar_combustible_ejercicio`
reporta es total **$980,000** / efectivo **$130,000** = **13.27 %**, con holgura
de sobra. El siguiente CFDI de diésel en efectivo que llegue —digamos **$11,600**—
sale `combustible_efectivo_dentro15` y **deducible al 100 %** cuando por el
cómputo real ya habría empezado a caer en `efectivo_sobre_15`. La divergencia cae
del lado de **conceder de más**, que es el lado que `administracion.ts:194-196`
declara caro.

Y en `0355`, el mismo criterio ancho con `p_desde/p_hasta` variable produce el
efecto de rótulo: la vista del **ejercicio** deduplica un par que la vista
**mensual** no ve junto, así que los 12 meses del panel no suman el año.

**Me refuté antes de escribirlo.** Busqué si la partición incluyera algo que lo
salve: incluye `monto` y `concepto`, no `fecha` ni `viaje_id` — igual que el
original, que se lo puede permitir porque su universo ya es un viaje. Y verifiqué
que el riesgo no sea teórico en el original: `engine.ts:552-555` argumenta que
dos tickets con folios que solo difieren en ceros, mismo concepto y mismo total
«es justo la definición de un duplicado» — argumento válido **dentro de un
viaje**, donde el mismo camión cargó una vez; a escala de tenant-año deja de
serlo.

**Causa raíz probable:** el predicado se portó por su forma (las llaves de
partición) y no por su contrato (el universo sobre el que se aplica).

---

### [MEDIO] FIS-M2 — `traerTodoDesdeId` no es inmune a inserciones, aunque `e2038a5` lo afirme: su salida temprana por conteo puede truncar el fondo de candidatos del consolidado, y una línea de diésel truncada queda «sin CFDI»

`src/lib/likida/pg.ts:264` y `:267`, textual:

```ts
if (pagina === 0 && typeof res.count === 'number') esperadas = res.count;
filas.push(...pag);
if (esperadas !== null && filas.length >= esperadas) return filas;
```

· el consumidor nuevo: `src/lib/likida/intake/consolidado.ts:338-351`
(`candidatosDeGasto`), con `count: 'exact'` solo en la primera página (`:341`) y
`PAGINA = 1_000` (`pg.ts:45`).
· la afirmación del commit `e2038a5`: «inmune a inserciones/borrados **en
cualquier otra parte de la tabla** mientras se pagina».

No lo es. El cursor por `id` protege contra el **desplazamiento** de `range()`,
pero `esperadas` se congela en la página 0 y `gasto.id` es `gen_random_uuid()`:
una fila insertada durante la paginación cae con ~50 % de probabilidad **después**
del cursor, se lee, e infla `filas.length` hasta cruzar `esperadas` antes de
llegar al final del rango.

**Norma** — `normas/rmf-2026-3.3.1.7.yaml` es la que sostiene el camino del
consolidado, y está en **`evidencia_corroborante`**: *no verificable en esta
ronda*. Lo que cito como norma dura es
`normas/lisr-27-III.yaml` (también `evidencia_corroborante`, lo anoto igual) solo
para el efecto: un gasto sin CFDI ligado no ampara deducción. El hallazgo es de
integridad de lectura, no de interpretación.

**Escenario, con pesos.** Flota de 500 viajes/día. Estado de cuenta ECC mensual
del monedero, **2,400 líneas**. `candidatosDeGasto` lee los gastos del mes sin
CFDI: `count` = **2,400**, página 0 devuelve 1,000. Mientras corre (son segundos
de red), tres choferes mandan fotos por WhatsApp y `processor.ts` inserta 3
gastos nuevos cuyos uuid caen después del cursor. Página 1 devuelve 1,000 filas
(997 viejas + 3 nuevas) y página 2 devuelve 400: `filas.length` llega a 2,400 y
`:267` **devuelve** — habiendo dejado 3 gastos del mes fuera del fondo.

Esas 3 líneas del ECC no encuentran candidato, se guardan
`estatus = 'por_conciliar'` (`consolidado.ts:516`) y sus gastos quedan **sin
`cfdi_uuid`**. Si son tres cargas de diésel de **$8,000** cada una: **$24,000**
que el panel del contador cuenta como «sin CFDI» (`tiene_cfdi = false` en
`0355:42`), es decir **$3,310.34 de IVA sin acreditar** (16 % de la base) y
$24,000 que no entran a la deducción del mes hasta que alguien resuelva la cola a
mano. Sin alerta: `LecturaIncompleta` no se lanza, porque el conteo cuadró.

**Me refuté antes de escribirlo.** Comprobé si la página vacía de `:268-273`
salvara el caso: solo se alcanza si el `>= esperadas` no disparó antes, y aquí
dispara. Y comprobé si el error fuera peor en el código anterior: sí, `traerTodo`
podía duplicar — pero el commit vende inmunidad total, y el rubro es que el
rótulo sea verdad.

**Causa raíz probable:** se cambió el mecanismo de paginación (posición →
cursor) y se conservó el criterio de terminación del mecanismo viejo (un conteo
tomado una sola vez).

---

### [MEDIO] FIS-M3 — el cubo del 15 % se sigue definiendo por exclusión de la lista de la **LISR 27-III** (cinco familias) y no de la que la **RFA 2.9** enumera (cuatro), y la elección sigue sin declararse (REINCIDENTE de la 29)

`src/lib/likida/cuadre/engine.ts:120-126` (`MEDIOS_LISR_27_III = ['02','03','04','05','28','29']`),
`:221-225` (el predicado del cubo), espejado en SQL en
`0345_combustible_rep_por_definir.sql:31` y heredado sin cambio por
`0349:84`.

**Norma** — `normas/rfa-2026-2.9.yaml`, **`verificado_fuente_primaria`**, líneas
13-17, literal:

> «…cuando los pagos por consumo de combustible se realicen con **medios
> distintos a cheque nominativo de la cuenta del contribuyente; tarjeta de
> crédito, de débito o de servicios; o monederos electrónicos autorizados por el
> SAT**, siempre que estos no excedan el 15 por ciento…»

Cuatro familias. La LISR 27-III (`normas/lisr-27-III.yaml:9-14`,
**`evidencia_corroborante`** — *no verificable en esta ronda*) abre con una
quinta, la **transferencia electrónica**, que la RFA no menciona. El motor
construye el cubo de la RFA por exclusión de la lista de la LISR, con `'03'`
dentro.

Escenario y cifras sin cambio respecto de la 29 (flota 624, $1,000,000 de
combustible: $700,000 por transferencia, $160,000 en efectivo, $140,000 con
tarjeta → **$150,000 de deducción y $24,000 de IVA** de diferencia entre las dos
lecturas). Lo que reporto no es el resultado —la lectura del motor es la
defendible— sino que **la elección no está declarada**, existiendo doctrina
explícita en el mismo archivo para hacerlo (`LECTURA_RFA_29_PRORRATEO`,
`engine.ts:258-270`; `BASE_ESTIMULO_PEAJE`). Reverificado hoy: `engine.ts:120-126`
y `:221-225` sin cambio; `rfa-2026-2.9.yaml:60-71`
(`lectura_aplicada_por_el_motor`) sigue enumerando dos lecturas, ninguna es ésta.

---

### [MEDIO] FIS-M4 — el denominador del 15 % sigue sumando combustible COMPRADO y la regla dice «pagos EFECTUADOS» (REINCIDENTE de la 27; `0349` lo declara fuera de alcance por escrito)

`supabase/migrations/0349_combustible_15_sin_copias.sql:80` —
`coalesce(sum(monto), 0) as total`, sin mirar forma de pago ni `pagado_en`,
mientras `:81-85` sí la exige para el numerador. Es la misma línea de
`0345:27`, heredada íntegra.

**Norma** — `normas/rfa-2026-2.9.yaml`, **`verificado_fuente_primaria`**, línea
16, literal: «…siempre que estos no excedan el 15 por ciento **del total de los
pagos efectuados** por consumo de combustible para realizar su actividad.»

Lo cuento porque sigue vivo, no porque sea trabajo nuevo: `0349:18-24` lo declara
fuera de alcance con su razón escrita («es una interpretación fiscal con efecto
real en el monto acreditable, no una corrección mecánica: se deja señalada, no se
adivina»). Esa es la forma correcta de dejar abierto un hallazgo fiscal, y lo
anoto como tal. Escenario y cifras en `docs/auditoria-27/fiscal.md`.

---

### [MEDIO] FIS-M5 — dos fichas `verificado_fuente_primaria` siguen dando instrucciones OPUESTAS sobre la caseta estatal, y las dos se le siguen entregando al chat en el mismo tema (REINCIDENTE de la 29)

`normas/rmf-2026-9.1.7.yaml:53-57` (**`verificado_fuente_primaria`**), literal:
«…**NO extiende el estímulo de peaje a autopistas concesionadas ni estatales** …
**una caseta fuera de esa Red no genera estímulo**.»
contra `normas/red-nacional-autopistas.yaml:78-85`
(**`verificado_fuente_primaria`**), literal: «**NO CONSTRUIR LISTA BLANCA DE
CASETAS. Prácticamente toda plaza del RNC cae dentro de la Red**; lo que hay que
filtrar NO es la geografía sino el medio de pago y la trazabilidad.»

Sin cambio: las dos siguen declarando `usado_en_codigo: []` mientras viven en
`src/lib/likida/normas/consulta.ts:52-56`, tema `peajes_y_casetas`, que es lo que
`consultar_normas` le entrega al analista. Escenario y cifras ($100,000 de
casetas estatales con TAG → $50,000 de estímulo impreso «sujeto a elegibilidad»)
en `docs/auditoria-29/fiscal.md`.

---

### [BAJO] FIS-B1 — `exigibleHasta` sigue sin un solo lector de producción, a tres meses y medio de que venzan las cinco fichas de la RFA 2026 (REINCIDENTE de la 29)

`src/lib/likida/normas/indice.ts:92` (la definición) y `:352`, `:364`, `:376`,
`:388`, `:400` (poblado con `"2026-12-31"` en las cinco fichas de la RFA).
`grep -rn "exigibleHasta" src/` **sin** `*.test.ts` devuelve exactamente esas seis
líneas: **cero lectores**. `normas/consulta.ts:106-108` sigue exponiendo
`exigible_desde` sin contraparte `hasta`.

**Norma** — no es un artículo: es la vigencia que la propia ficha declara,
`normas/rfa-2026-2.9.yaml:24` (`fecha_vigencia_hasta: 2026-12-31`).

Escenario sin cambio (8-ene-2027, el chat cita la 2.9 como vigente ocho días
después de su vencimiento). Lo mantengo porque hoy faltan **110 días** para esa
fecha y el campo ya está poblado y cotejado, a un `if` de distancia.

---

### [BAJO] FIS-B2 — el `ayuda` de la pregunta de dedicación sigue afirmando que es «válvula … del estímulo de peaje», y el estímulo de peaje sigue sin leerla (REINCIDENTE de la 29)

`src/app/dashboard/onboarding/forma.tsx:104`, textual: «…Válvula del 15 % de
combustible en efectivo **y del estímulo de peaje**.» contra
`src/lib/likida/perfil/preguntas.ts:126-133` (`calificaEstimuloPeaje`, que solo
mira `menoresA300M` y `parteRelacionada`) y `engine.ts:1718-1719`.

**Norma** — `normas/lif-2026-20-A.yaml`, **`verificado_fuente_primaria`**,
`estimulo_peaje.texto_vigente` (líneas 147-149): «Se otorga un estímulo fiscal a
las personas contribuyentes **que se dediquen exclusivamente al transporte
terrestre público y privado, de carga o pasaje, así como el turístico**…».
Contestar «No» a esa pregunta no mueve un peso del estímulo de peaje; y el rótulo
queda además desalineado con la pregunta, que `99fba32` estrechó a carga federal
mientras la LIF cubre pasaje y turismo.

---

### [BAJO] FIS-B3 — el comentario que funda la retención cita la migración equivocada

`src/lib/likida/facturacion_escritura.ts:156`, textual: «`// FIS-M3 (mig. 0351):
retención del 4% de IVA, opcional`». La migración es **`0352_factura_retencion_iva.sql`**;
`0351_costo_fase_copiloto_runner.sql` es la de `FaseCosto`. Es la única línea del
repo que dice de dónde sale la columna `retencion_iva`, y apunta a otra parte.

**Norma** — `normas/rliva-3-fr-II.yaml`, **`verificado_fuente_primaria`**, cuyo
`por_que_importa` existe precisamente porque «el comentario que la fundaba citaba
la norma equivocada por partida doble» (líneas 36-38). El mismo modo de falla,
un nivel más abajo: ahora la cita mal la migración en vez de la norma.

---

## Lo que revisé y está bien

- **El cotejo de `8fc2fa7` en su ruta propia es real y su prueba muerde.**
  `repo.ts:1616-1632` + `facilidad15_regimen_cotejado.test.ts` (**8 pasan**,
  corrido hoy): el caso 601+Sí afirma `rpc` **no llamado**, así que revertir el
  bloque lo pone rojo por escritura, no por mensaje. Y falla cerrado si no puede
  leer la clave (`:1624`, caso `:131-136`). Ficha:
  `normas/rfa-2026-2.9.yaml`, **`verificado_fuente_primaria`**.
- **El reintento del consolidado ECC no duplica deducción** (foco (c), refutado
  con detalle arriba): `unique (cfdi_xml_id, indice)` en
  `0076_cfdi_consolidado.sql:66`, salida temprana en `consolidado.ts:440-443`,
  reanudación por sello `cfdi_orden` en `:457-483`, y `decidirCruce`
  (`cruce.ts:102-121`) puro respecto de `fondo` en las tres reglas que deciden
  `consolidado`.
- **`0355` sí cierra el reincidente «el panel del contador cuenta las copias que
  el PDF descarta»** (abierto desde la 27). `fiscal.ts:1652` prueba que TODO el
  panel entra por `gastos_fiscales_agregados_tenant`, y `0355:104-122` ahora la
  deduplica antes de agregar, así que `fiscal.ts:1117` (`gastoTotal += g.monto`)
  ya no suma copias aunque `copiasDeComprobante` no aparezca en ese archivo. Es
  el cierre estructural de la ventana en este rubro — le pongo la reserva de
  FIS-A3 (no hay test) y de FIS-M1 (el criterio es más ancho que el del motor),
  no le quito el mérito.
- **`0352` y su test son ejemplares en el sentido que este rubro exige**: el test
  contiene el caso que diverge (`retencion_iva=400, total=11200`, imposible bajo
  el CHECK viejo) y las dos direcciones de rechazo. Ficha
  `normas/rliva-3-fr-II.yaml`, **`verificado_fuente_primaria`**.
- **La tasa del 4 % y su condición están bien implementadas donde Likida timbra.**
  `carta_porte_cfdi.ts:200` (`esMoral = re.rfc.length === 12`; RFC de 13 = persona
  física → `null`), `:202` (`total = sub + iva - ret`), `:234`
  (`TasaOCuota="0.040000"`), `:239` (`TotalImpuestosRetenidos`). Coincide al pie
  con `rliva-3-fr-II.yaml:14-17`, que solo obliga a **personas morales**.
- **El estímulo de IEPS de diésel sigue siendo litros, no el IEPS trasladado del
  CFDI.** `engine.ts:1629` (`const iepsAcreditable = 0`), `:1756` (litros solo con
  `MEDIOS_LISR_27_III`), `acreditable.ts:101-103`. Contra
  `normas/lif-2026-20-A.yaml:114-123`, **`verificado_fuente_primaria`**. La regla
  que el encargo nombra explícitamente está respetada.
- **El guardia de litros contra el monto sigue vivo** (`engine.ts:1766-1777`,
  razón fuera de 0.5×–2× → `diesel_desviacion`, sin acreditar).
- **El tope de alimentación está bien fundado en su «por beneficiario».**
  `engine.ts:1519-1533` argumenta explícitamente que la liquidación es de un solo
  operador, y `0355:124-131` agrupa por `(viaje_id, dia)` — coherente. Contra
  `normas/lisr-28-V.yaml:21-25`, **`verificado_fuente_primaria`**: «…no exceda de
  $750.00 diarios **por cada beneficiario**…». El motor no duplica el criterio:
  vive en `tope_alimentacion.ts`, compartido con `resumirFiscal`.
- **La leyenda del permiso CRE sigue citando bien.** `deducibilidad.ts:78` es la
  ÚNICA cita normativa de ese archivo, y las dos fuentes la dicen:
  `lisr-27-III.yaml:19-22` y `rfa-2026-2.9.yaml:18-21` («en el comprobante fiscal
  deberá constar la información del permiso vigente, expedido de acuerdo con la
  Ley de Hidrocarburos»).
- **`cuadre/leyendas.ts` no cita una sola norma fiscal de deducibilidad** — sus
  referencias son CFF 89/90 y CFF 52, con ficha `normas/cff-89-90.yaml`. No hay
  ahí un artículo colgado de una cifra.

**Inventario de verificación de fichas, medido hoy sobre las 39:**
`verificado_fuente_primaria` entre las que crucé y que por tanto ganan cualquier
discusión: **`rfa-2026-2.9`**, **`lisr-72-73`**, **`lisr-28-V`**,
**`rliva-3-fr-II`**, **`lif-2026-20-A`**, **`rmf-2026-9.1.7`**,
**`red-nacional-autopistas`**, **`rmf-2026-9.1.8`**, **`cff-69-B`**,
**`cff-89-90`**.
**No verificables en esta ronda** (`evidencia_corroborante`, sin texto literal en
fuente primaria — no se asume que estén bien ni mal): **`lisr-27-III`**,
`lisr-28-XX`, `cff-29-A`, `criterio-1-LIF-PI`, `rmf-2026-2.7.1.21`,
`rmf-2026-2.7.1.48`, **`rmf-2026-3.3.1.7`**; y `politica-portales-plazos`
(`sin_verificar`). Sigue en pie el techo que la 28 escribió: mientras la
**27-III** —la fracción detrás del veredicto rojo más frecuente del motor y del
importe de $2,000— no se cierre contra fuente primaria, **el ancla de 8+ es
inalcanzable por construcción**, con independencia del código.

## Lo que NO alcancé a revisar

- **Nada que requiera base viva.** Sin Postgres no ejecuté `0349`, `0352`, `0355`,
  `0345` ni `gastos_fiscales_agregados_tenant`: los leí contra sus tests SQL y
  contra el TS que los llama, que es lo que el MAPA pedía. FIS-A3 y FIS-M1 son
  hallazgos de esa lectura, no de una corrida.
- **Ningún render.** No levanté preview de `/dashboard/onboarding` ni de
  `/dashboard/facturacion`: los dos hallazgos de pantalla se sostienen en el
  `archivo:línea` del formulario y de la acción de servidor que consume su
  `name`, más la medición con las funciones reales.
- **`intake/cfdi.ts` sigue sin auditarse a fondo** — quinta ronda — y su ficha de
  referencia (`cff-29-A`) es `evidencia_corroborante` con `texto_vigente: null`:
  **no verificable en esta ronda** por construcción.
- **`sat_descarga/` quedó auditado solo en el eje del foco (c)**: `ciclo.ts`,
  `cruce.ts` (`decidirCruce`) y `consolidado.ts`. `bandeja.ts`, `resolucion.ts`,
  `peaje_cierre.ts` y `zip.ts` siguen sin cruzar.
- **`0354_cierre_insumos_hash_v2.sql`** (REP '99' fuera del combustible en
  efectivo) es fiscal-adjacente y lo dejé a `datos`, que lo tiene asignado: su
  test SQL sí existe. No lo abrí a fondo.
- **`rfa-2026-3.12` sigue sin ficha** (39 archivos, ninguno es 3.12), así que el
  cierre fail-closed de una flota de pasaje/turismo deja abierto qué regla sí la
  alcanza. Es lo que mantiene latente a FIS-B2.
- **`rmf-2026-2.7.7` (Carta Porte, obligados y radio de 30 km)**,
  `criterios-imss-sbc` y `lss-27` quedaron otra vez sin cruzar: los tres focos
  obligatorios se llevaron la ronda.
