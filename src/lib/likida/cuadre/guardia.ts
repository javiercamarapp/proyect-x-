// GUARDIA DETERMINÍSTICA (código, no prompt): el LLM NUNCA reporta cifras que no
// vengan de una tool en ese mismo turno. Es el backstop de la regla fundacional
// (f/g): no depende de que el modelo obedezca.
//
// Regla (por qué cada caso):
//  - Si llamó cuadrar_viaje → la respuesta ES sobre el cuadre. El LLM pudo
//    transcribir mal un número al narrarlo, así que se REEMPLAZA por el resumen
//    determinístico del motor (autoritativo). Cierra el hueco "tool llamada pero
//    número narrado incorrecto".
//  - Si NO llamó cuadrar_viaje NI consultar_politica pero hay cifras → números
//    ungrounded (inventados). Se da el cuadre real de la DB.
//  - Si solo consultó política y hay cifras → se COTEJA cifra por cifra contra
//    lo que la tool devolvió. Antes bastaba con que la llamada existiera, y eso
//    era una puerta trasera: consultar la política —barata y siempre
//    disponible— desbloqueaba narrar cualquier número, incluido un cuadre
//    inventado colado en la misma frase que un tope real.
//  - FAIL-CLOSED: si no se puede calcular el cuadre real, NO se envían cifras;
//    se responde neutral en vez de arriesgar un número inventado.

import { cuadrarDesdeDB } from './desde_db';
import { resumenCuadre, type CuadreParaResumen } from './resumen';
import { tieneCifrasDeDinero, cifrasSinRespaldo, hablaDeDineroSinCifraVerificable } from './cifras';
import { logger } from '@/lib/logger';
import { registrarEventoSeguridad } from '@/lib/seguridad/eventos';
import type { ToolCallRecord } from '@/lib/llm/openrouter';

export async function guardiaCifras(
  reply: string,
  toolCalls: ToolCallRecord[],
  tenantId: string,
  viajeId: string,
): Promise<{ reply: string; forzado: boolean }> {
  // `guardar_liquidacion` TAMBIÉN es un cierre. Antes solo se miraba
  // `cuadrar_viaje`, así que un turno que cerró de verdad —y al que le sigue el
  // PDF— encabezaba "Este es el cuadre de tu viaje" en vez de "Listo, cuadré tu
  // viaje". Las cifras salían bien; lo que quedaba mal era si el operador
  // entendía que su viaje ya estaba cerrado.
  const cuadro = toolCalls.some(
    (t) => (t.toolName === 'cuadrar_viaje' || t.toolName === 'guardar_liquidacion') && !t.error,
  );
  // `cuadro` y `cerro` son DOS preguntas distintas y hay que tenerlas separadas:
  //   `cuadro` → "¿hay números que respaldar?" (decide si se sustituye el texto)
  //   `cerro`  → "¿el viaje quedó cerrado en este turno?" (decide el encabezado)
  //
  // Pasarle `cuadro` al parámetro `cerrado` de `resumenCuadre` hacía que un turno
  // que sólo calcula —"¿cuánto llevo?" → `cuadrar_viaje`, sin `guardar_liquidacion`—
  // encabezara "Listo, cuadré tu viaje" con el viaje todavía `abierto` y la tabla
  // `liquidacion` vacía. El chofer dejaba de mandar comprobantes esperando un PDF
  // que nadie iba a generar, y el panel del contralor no tenía esa liquidación.
  // Es el mismo hecho que `processor.ts` llama `closed`, calculado igual.
  const cerro = toolCalls.some((t) => t.toolName === 'guardar_liquidacion' && !t.error);
  const consultoPolitica = toolCalls.some((t) => t.toolName === 'consultar_politica' && !t.error);

  // ── AUDITORÍA 7, CRÍTICO AG-3 — DOS FOTOGRAFÍAS DISTINTAS DE LA BASE ────────
  //
  // `guardar_liquidacion` calcula el cuadre y genera los DOS PDF en UN momento
  // (T1, tools.ts) y devuelve ese mismo cuadre dentro de `result.liq`. Esta
  // guardia volvía a llamar `cuadrarDesdeDB` en OTRO momento (T2) para armar el
  // texto — y entre T1 y T2 las fotos entrantes NO toman mutex (processor.ts:
  // comentario explícito), así que un comprobante que entra en esa ventana hacía
  // que el PDF archivado y el WhatsApp narraran DOS cuadres distintos del MISMO
  // cierre, a veces de signo contrario ("Sobró $150" vs "Pusiste $650 de tu
  // bolsa", con $800 de diferencia).
  //
  // El fix: si CERRÓ en este turno, se usa el snapshot que la tool ya devolvió
  // — la MISMA lectura que se imprimió en los dos PDF — en vez de recalcular.
  // Solo se recalcula si por alguna razón el snapshot no viene (defensivo; no
  // debería pasar con la tool ya cableada).
  const snapshotCierre = cerro
    ? (toolCalls.find((t) => t.toolName === 'guardar_liquidacion' && !t.error)
        ?.result as { liq?: CuadreParaResumen } | undefined)?.liq
    : undefined;

  // El detector NO decide sobre un cuadre. Antes esta función salía en la primera
  // línea si `tieneCifrasDeDinero` decía que no, lo que ponía a un regex —que por
  // definición tiene falsos negativos— a decidir sobre el caso más importante: el
  // turno en que SÍ se calculó el cuadre. Si el modelo cuadraba y narraba el
  // resultado de una forma que el detector no reconocía, el texto salía sin
  // verificar. Y ese es el camino feliz de la demo: foto → "listo" → el agente
  // narra.
  //
  // Cuando hubo cuadre, la respuesta ES sobre el cuadre y se sustituye siempre.
  if (!cuadro && !tieneCifrasDeDinero(reply)) return { reply, forzado: false };

  // Cifras de política sin ser un cuadre: se respetan SOLO las que de verdad
  // salieron de la tool. Basta una cifra sin respaldo para no confiar en el
  // texto completo — no se puede tachar el número malo y mandar el resto.
  if (!cuadro && consultoPolitica) {
    // Cantidad en palabras: se detecta que habla de dinero pero no hay número que
    // cotejar. Lista vacía significaría "todo respaldado", así que hay que
    // distinguir "verificado y correcto" de "no se pudo verificar".
    if (hablaDeDineroSinCifraVerificable(reply)) {
      logger.warn('guardia_cifra_no_verificable', { tenantId, viajeId });
    } else {
      const respaldos = toolCalls.filter((t) => !t.error).map((t) => t.result);
      const fuera = cifrasSinRespaldo(reply, respaldos);
      if (fuera.length === 0) return { reply, forzado: false };
      logger.warn('guardia_cifras_sin_respaldo', { tenantId, viajeId, cifras: fuera });
      void registrarEventoSeguridad({ origen: 'chat', tipo: 'cifra_sin_respaldo', tenantId, detalle: { viajeId, cifras: fuera.slice(0, 8) } });
    }
  }

  try {
    // ── AMPLIACIÓN DE AG-3 (AUDITORÍA 28, TC-A1) ────────────────────────────
    // `cerro` sin `snapshotCierre` significaba, hasta aquí, "recalcula en
    // `best_effort`" (el comentario viejo lo llamaba "defensivo; no debería
    // pasar"). Pero SÍ pasaba: `confirmarCierreEnBase` fabricaba un registro
    // sintético sin `liq` cada vez que recuperaba un cierre que la tool no
    // pudo devolver en vivo, y `cuadrarDesdeDB(tenantId, viajeId)` SIN
    // opciones cae en `best_effort` (perfil, acumulado del ejercicio y líneas
    // ECC degradan en silencio) mientras lo archivado se calculó en `cierre`
    // — el PDF y el WhatsApp del MISMO cierre podían narrar dos cuadres
    // distintos. Ahora `confirmarCierreEnBase` SIEMPRE intenta traer el
    // snapshot archivado; si de verdad no puede (fila no encontrada, lectura
    // caída), esto es lo único correcto: fallar cerrado y decirlo, nunca
    // inventar un cuadre nuevo sobre un cierre que ya quedó impreso distinto.
    if (cerro && !snapshotCierre) {
      logger.error('guardia_cierre_sin_snapshot', { tenantId, viajeId });
      return { reply: 'Ya cerré tu liquidación ✅. Te mando el PDF.', forzado: true };
    }
    // AG-3: con snapshot de cierre, NO se toca la DB — se narra exactamente lo
    // que ya quedó impreso en los dos PDF y persistido en `saveLiquidacion`.
    const liq = snapshotCierre ?? (await cuadrarDesdeDB(tenantId, viajeId));
    // cerrado=cerro: el encabezado afirma el cierre SOLO si `guardar_liquidacion`
    // corrió sin error en este turno. Ver el comentario de `cerro` arriba.
    //
    // 'operador' NO es opcional aquí: esta respuesta va por WhatsApp AL CHOFER, y
    // sin el destinatario caía al default 'contralor' — mandándole veredictos que
    // él no puede arreglar (proveedor en lista 69-B, CFDI cancelado, RFC receptor)
    // más el descargo legal. Y pasa en el CAMINO FELIZ: foto → "listo" → el agente
    // narra → la guardia reemplaza. O sea, delante del comprador en el demo.
    return { reply: resumenCuadre(liq, cerro, 'operador'), forzado: true };
  } catch (err) {
    logger.error('guardia_cifras_fail_closed', { tenantId, viajeId, err: String(err) });
    return {
      reply: 'Dame un momento para cerrar bien tu cuadre y te confirmo los números. 🙏',
      forzado: true,
    };
  }
}
