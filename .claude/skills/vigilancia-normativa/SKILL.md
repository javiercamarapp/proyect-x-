---
name: vigilancia-normativa
description: Vigila el DOF, el minisitio del SAT y los textos de ley en diputados.gob.mx para detectar cuándo alguna de las fichas de `normas/*.yaml` dejó de ser cierta, y abre PR marcándola como contradicha con el radio de impacto en el código. Úsala en el barrido diario, al preguntar si cambió alguna norma, antes de un demo o de facturar, cuando una ficha lleve meses sin verificar, o al revisar si el SAT publicó una modificación anticipada.
---

# Vigilancia normativa

Las fichas de `normas/` no se rompen con un error: se vuelven mentira en silencio. El SAT publica, el código sigue igual, y el PDF del contralor sigue citando un artículo que ya dice otra cosa.

Esta rutina no interpreta la ley. **Detecta que algo se movió y señala qué código depende de eso.** La lectura la hace un humano — que la regla 2.9 de la RFA le abra una excepción a LISR 27-III es una relación que se establece leyendo, no diffeando.

## CRITICAL

- **Barrer 7 días, no 5.** La RMF 2026 completa se publicó en **domingo** (28-dic-2025). Un barrido que salta fines de semana se pierde la publicación más importante del año.
- **Las tres ediciones, siempre.** Matutina, vespertina y extraordinaria. La LIF, la reforma al CFF y las 10 cuotas de diésel salieron en **vespertina**.
- **`Nota Aclaratoria` y `Fe de erratas` son disparadores.** El 24-jul-2026 salió una aclaratoria a reglas del 20-jul. Sin esos términos en el diccionario, pasa de largo.
- **La rutina nunca cambia `estado_verificacion` a verificado.** Solo puede marcar `contradicho`. Subir una ficha a `verificado_fuente_primaria` exige que una persona lea la fuente y la firme.
- **Renumeración sin cambio de texto.** El diff no la ve. `rmf-2026-2.7.1.21` ya migró desde 2.7.1.24. Hay que verificar que el número siga apuntando al mismo tema, no solo que el texto no cambie.

## Las tres vigilancias, con su cadencia

**Diaria — barrido del DOF.** `GET sidofqa.segob.gob.mx/dof/sidof/notas/{DD-MM-AAAA}` sobre el día anterior, las tres ediciones. Filtrar los títulos contra el diccionario de disparadores: `Miscelánea Fiscal`, `facilidades administrativas`, `Ley de Ingresos`, `Código Fiscal`, `Impuesto sobre la Renta`, `valor agregado`, `producción y servicios`, `datos personales`, `autotransporte`, `Anexo`, `Nota Aclaratoria`, `Fe de erratas`.

**Semanal — anticipadas del SAT.** `HEAD` al minisitio de normatividad. Si cambia el `ETag`, diffear la lista de PDFs y buscar en los nuevos las reglas de las fichas. Esto cierra una **ventana ciega de cuatro meses y medio**: la 1ª modificación a la RMF 2026 vivió en el portal del 23-feb al 9-jul con efectos jurídicos, sin pasar por el DOF.

**Trimestral — deriva de ley.** `HEAD` a los PDFs de CFF, LISR, LIVA y LFPDPPP en `diputados.gob.mx/LeyesBiblio/pdf/`. Su `Last-Modified` rastrea la reforma. Si cambió, diffear el historial en `ref/*.htm`.

Detalle de endpoints, qué respondió cada uno y qué rutas están muertas: `references/fuentes.md`.

## Cómo decide que algo cambió

AUDITORÍA 28, FIS-M2 (MEDIO, mecánico): esto decía que "cada ficha lleva `hash_texto_vigente`... y un bloque `vigilancia`" — ninguna de las 39 fichas de `normas/*.yaml` trae hoy ninguno de los dos campos (verificado con `grep`). El mecanismo REAL es el del barrido: cruzar el TÍTULO de cada publicación del DOF contra el diccionario de disparadores (`Miscelánea Fiscal`, `facilidades administrativas`, `Ley de Ingresos`, `Código Fiscal`, `Impuesto sobre la Renta`, `valor agregado`, `producción y servicios`, `datos personales`, `autotransporte`, `Anexo`, `Nota Aclaratoria`, `Fe de erratas` — ver `references/prompt.md`, sección 1). Si un `hash_texto_vigente`/bloque `vigilancia` por ficha DEBERÍA existir (para detectar, ficha por ficha, que su `texto_vigente` cambió sin depender de palabras clave en un título), es trabajo pendiente — no algo ya construido. Cuando el barrido encuentra una publicación que toca los disparadores de una ficha:

1. Marca `estado_verificacion: contradicho` y actualiza `verificado_el`.
2. Pega el texto nuevo y el `codNota`.
3. **Lista los archivos de `usado_en_codigo`.** Ese es el radio de impacto real, y es lo que convierte una alerta en trabajo accionable.

## La expectativa correcta

Esto acierta poco y vale la pena de todas formas. El único build detallado de vigilancia regulatoria que se pudo verificar declara **4–6% de tasa de acierto** — 800 a 900 publicaciones al mes, 30 a 50 relevantes — y que los sitios cambiaron de estructura **tres veces en ocho meses**, rompiendo el scraper cada vez.

Esta rutina se mide por el mes en que atrapa una, no por su ratio diario. Y por eso el latido importa tanto: sin él, un scraper roto se ve exactamente igual que un mes tranquilo.

## Lo que no puede hacer

Que el 15% de combustible en efectivo pase a 10% es una lectura de contador. Los criterios no vinculativos viven en el Anexo 3, que se publica por goteo semanas después. La jurisprudencia del TFJA no está en el DOF. Y los hallazgos doctrinales abiertos de las fichas —si el 50% de peaje se calcula sobre subtotal o sobre el gasto erogado con IVA— no los cierra ningún diff.

El super prompt de la routine está en `references/prompt.md`.
