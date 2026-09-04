// ═══════════════════════════════════════════════════════════════════════════
// TOOLS del agente `liquidacion`. Se registran al importar este módulo.
//
// Nota de diseño: extraer_comprobante NO es tool del LLM — corre en el pipeline
// de WhatsApp al llegar una foto (el LLM no puede pasar bytes de imagen). El
// LLM ve los gastos ya extraídos como contexto y decide cuándo cuadrar/cerrar.
// ═══════════════════════════════════════════════════════════════════════════

import { idLiquidacionDeViaje } from '@/lib/likida/liquidacion/id';
import { registerTool, type ToolContext } from '@/lib/llm/tool-executor';
import { cuadrarDesdeDB } from './cuadre/desde_db';
import { copiasDeComprobante } from './cuadre/engine';
import { estaApagado } from './interruptores';
import { registrarCorrida } from './agentes/corridas';
import {
  getViaje, getOperador, saveLiquidacion, leerSnapshotInsumosCierre,
  insumosDeCierreCambiaron,
} from './repo';
import { getConfig } from './config';
import { generarLiquidacionPDF } from './liquidacion/pdf';
import { getDatosFiscales } from '@/lib/saas/fiscal';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import type { Liquidacion } from '@/types/likida';
import { normasDe, normasDePolitica } from './normas/por_diferencia';
import { getAcumuladoCombustible } from './repo';
import { evaluarTope15 } from './periodo/combustible';
import { avisoTope15 } from './periodo/aviso';
import { NORMAS, esVinculante } from './normas/indice';

// ── consultar_politica ──────────────────────────────────────────────────────
registerTool('consultar_politica', {
  schema: {
    type: 'function',
    function: {
      name: 'consultar_politica',
      description: 'Trae la política de gastos de la flota (topes por concepto/ruta). Úsala antes de cuadrar.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  handler: async (_args, ctx) => {
    const config = await getConfig(ctx.tenantId);
    // ── EL PERMISO DE CITAR TIENE QUE VIAJAR CON LA POLÍTICA ────────────────
    //
    // AUDITORÍA 7, CRÍTICO. `permitidas` sale de `normasDeToolCalls`, que busca
    // la llave `norma_id`, y el ÚNICO sitio que la emitía era `cuadrar_viaje`.
    // Con eso, el sistema tenía una trampa cerrada sobre sí misma:
    //
    //   · turno CON `cuadrar_viaje` → `guardiaCifras` fuerza el texto SIEMPRE
    //     (guardia.ts:37-39 y :79) → `textoDeterminista = true` → la guardia de
    //     fundamento NO CORRE. Los permisos existen y no sirven.
    //   · turno SIN `cuadrar_viaje` —el operador pregunta "¿y por qué no me
    //     cuentas ese diésel?"— → la guardia SÍ corre, con `permitidas = []`, y
    //     entonces TODA cita cae en CITA_DESCONOCIDA y se borra a media frase:
    //
    //       "…porque el artículo 27, fracción III de la LISR limita a $2,000…"
    //     →  "…porque el limita a $2,000…"
    //       "Te aplica el estímulo conforme al LIF 2026 Art. 20-A."
    //     →  "Te aplica el estímulo conforme al -A."
    //
    // El turno que tiene permisos es exactamente el turno en que la guardia no
    // corre; el turno en que corre nunca tiene permisos. El producto era
    // estructuralmente incapaz de citar una norma, y al intentarlo entregaba una
    // frase rota — con el estímulo del diésel, que es lo que se vende, saliendo
    // como "conforme al -A."
    //
    // Explicar un tope ES citar la norma que lo sostiene, así que el permiso
    // pertenece a esta tool tanto como a la del cuadre. Se emiten SOLO las que
    // respaldan lo que esta tool devuelve —los límites de la política—, no un
    // salvoconducto general: el resto sigue borrándose.
    const fundamentos = normasDePolitica(config.politica);
    return {
      politica: config.politica,
      fundamentos: fundamentos.map((id) => ({
        norma_id: id,
        cita: NORMAS[id].citas[0],
        jerarquia: NORMAS[id].jerarquia,
        verificada: NORMAS[id].estado !== 'sin_verificar',
        vinculante: esVinculante(NORMAS[id].jerarquia),
      })),
    };
  },
});

// ── cuadrar_viaje ───────────────────────────────────────────────────────────
const computeCuadre = cuadrarDesdeDB; // alias local (fuente compartida)

// ── estado_viaje ────────────────────────────────────────────────────────────
// La foto del viaje para el AYUDANTE DE RUTA (17-ago-2026): origen/destino,
// anticipo, cuánto lleva comprobado y el desglose por concepto (con litros de
// diésel cuando el OCR los leyó). LECTURA PURA — no toca nada, y el agente la
// usa para contestar "¿cuánto llevo?", "¿cuánto me queda?" o "¿cuánto diésel
// he cargado?" sin correr el cuadre completo.
registerTool('estado_viaje', {
  schema: {
    type: 'function',
    function: {
      name: 'estado_viaje',
      description: 'El estado actual del viaje del operador: origen/destino, anticipo, total comprobado (con la MISMA regla del cuadre: una foto repetida del mismo comprobante no se cuenta — `copias_excluidas` dice cuántas), desglose por concepto y litros de diésel leídos. Solo lectura — para dudas del chofer en ruta.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  handler: async (_args, ctx) => {
    if (!ctx.viajeId) return { error: 'sin_viaje' };
    const admin = supabaseAdmin();
    const [rViaje, rGastos] = await Promise.all([
      admin.from('viaje').select('origen, destino, anticipo, estatus').eq('id', ctx.viajeId).eq('tenant_id', ctx.tenantId).maybeSingle(),
      // AUDITORÍA 25 · TC-1 (ALTO, tool-calling.md:30): `.order('id')` ordenaba
      // por el uuid aleatorio de `gasto.id` — una permutación sin relación con
      // el orden de llegada. `copiasDeComprobante` conserva la PRIMERA
      // aparición como original, así que ese orden decidía cuál copia se
      // contaba, y `getGastos` (repo.ts, el camino del motor/PDF) ordena
      // distinto. `created_at` es el valor que no cambia tras el insert: es lo
      // que hace que esta tool y el motor elijan la MISMA copia.
      admin.from('gasto').select('id, concepto, monto, folio, folio_norm, cfdi_uuid, cfdi_orden, ocr_extra').eq('viaje_id', ctx.viajeId).eq('tenant_id', ctx.tenantId).order('created_at', { ascending: true }),
    ]);
    // Fallar cerrado: un error de lectura NO se convierte en "cero gastos".
    if (rViaje.error) throw new Error(`estado_viaje/viaje: ${rViaje.error.message}`);
    if (rGastos.error) throw new Error(`estado_viaje/gastos: ${rGastos.error.message}`);
    if (!rViaje.data) return { error: 'viaje_no_encontrado' };

    // ── AUDITORÍA 24, TC-1 (ALTO, 3ª ronda): LA MISMA REGLA DE CUBETAS QUE EL MOTOR
    // Esta tool sumaba `monto` de CADA fila de `gasto` y contaba cada fila como
    // comprobante; el motor (`cuadrarViaje`) excluye las copias del mismo
    // comprobante —por `(uuid, orden)` o por concepto+folioNorm+monto,
    // `copiasDeComprobante`— y los montos que no son > 0. Con el protocolo de
    // dos fotos (ticket + acercamiento) y el voucher que sale junto al ticket,
    // las copias son el flujo normal, no el caso raro: el chofer que escribía
    // "hola" leía "llevas 4 comprobantes por $25,443" de un anticipo de
    // $12,000 y al cerrar el PDF decía $9,681. Dos "comprobado" del mismo
    // viaje. Aquí se usa EXACTAMENTE el predicado exportado del motor, no una
    // copia de la regla, para que las dos cifras no puedan volver a separarse.
    const gastos = (rGastos.data ?? []).map((g) => ({
      id: String(g.id),
      concepto: g.concepto,
      monto: typeof g.monto === 'number' ? g.monto : Number(g.monto ?? 0),
      folio: (g.folio as string | null) || undefined,
      folioNorm: (g.folio_norm as string | null) || undefined,
      cfdiUuid: (g.cfdi_uuid as string | null) || undefined,
      cfdiOrden: g.cfdi_orden != null ? Number(g.cfdi_orden) : undefined,
      ocrExtra: (g.ocr_extra as Record<string, unknown> | null) ?? undefined,
    }));
    const copias = copiasDeComprobante(gastos);
    const porConcepto = new Map<string, { total: number; n: number }>();
    let comprobado = 0;
    let comprobantes = 0;
    let litrosDiesel = 0;
    for (const g of gastos) {
      // Misma regla que `totalComprobado` en engine.ts: ni copias ni montos <= 0.
      if (copias.has(g.id) || !(g.monto > 0)) continue;
      comprobado += g.monto;
      comprobantes += 1;
      const c = porConcepto.get(g.concepto) ?? { total: 0, n: 0 };
      c.total += g.monto; c.n += 1;
      porConcepto.set(g.concepto, c);
      // Los litros SOLO si el OCR los leyó — jamás se estiman de pesos — y
      // solo del gasto ORIGINAL: la copia del mismo ticket no cargó diésel dos veces.
      const litros = g.ocrExtra?.litros;
      if (g.concepto === 'diesel' && typeof litros === 'number' && Number.isFinite(litros)) litrosDiesel += litros;
    }
    return {
      origen: rViaje.data.origen, destino: rViaje.data.destino,
      estatus: rViaje.data.estatus, anticipo: rViaje.data.anticipo,
      comprobado, comprobantes,
      // Para que el modelo pueda decir "una foto repetida no se cuenta" en vez
      // de un número que el PDF después desmiente.
      copias_excluidas: copias.size,
      por_concepto: [...porConcepto.entries()].map(([concepto, v]) => ({ concepto, total: v.total, n: v.n })),
      litros_diesel_leidos: litrosDiesel > 0 ? litrosDiesel : null,
    };
  },
});

registerTool('cuadrar_viaje', {
  schema: {
    type: 'function',
    function: {
      name: 'cuadrar_viaje',
      description: 'Cuadra el viaje: compara los comprobantes contra el anticipo y la política, y devuelve total comprobado, diferencia y las diferencias detectadas. NO cierra la liquidación (eso es guardar_liquidacion).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  handler: async (_args, ctx) => {
    if (!ctx.viajeId) throw new Error('sin viaje activo');
    const liq = await computeCuadre(ctx.tenantId, ctx.viajeId);

    // LA CAPA DE PERIODO. El motor es puro y evalúa UN viaje, así que marca el
    // diésel en efectivo como "por confirmar" a ciegas: sin saber si la flota va
    // por el 3% del ejercicio —tranquila— o por el 14.8% —a punto de perder la
    // deducción de todo lo que pague en efectivo el resto del año—. Es la misma
    // información con dos valores completamente distintos para quien decide.
    //
    // Best-effort: si la consulta falla, el cuadre sale igual. El contador es
    // contexto valioso, no un requisito para cerrar un viaje.
    let periodo: { estado: string; razon: number; margen: number; excedente: number; aviso: string | null } | undefined;
    try {
      // AUDITORÍA 15, MEDIO (arquitectura): tools.ts usaba el año del PROCESO y
      // desde_db el año del viaje — dos barridos con dos criterios. Mismo ancla
      // que el motor: el año del viaje (los comprobantes), no el del reloj.
      const viajeCtx = await getViaje(ctx.viajeId, ctx.tenantId).catch(() => null);
      const ejercicio = viajeCtx?.fechaInicio ? Number(viajeCtx.fechaInicio.slice(0, 4)) : new Date().getUTCFullYear();
      const acum = await getAcumuladoCombustible(ctx.tenantId, ejercicio);
      const t = evaluarTope15(acum);
      // AUDITORÍA 14, ALTO: la elegibilidad de la flota (declarada al
      // registrarse) tiene que llegar al aviso — una flota no elegible no
      // recibe "te quedan $X antes de perder la deducción".
      const cfg = await getConfig(ctx.tenantId);
      const f15 = cfg.facilidadCombustibleEfectivo;
      const elegible = (f15 && f15.dedicacionExclusivaCarga !== undefined && f15.regimenElegible !== undefined)
        ? (f15.dedicacionExclusivaCarga === true && f15.regimenElegible === true)
        : undefined;
      periodo = { estado: t.estado, razon: Number(t.razon.toFixed(4)), margen: t.margen, excedente: t.excedente, aviso: avisoTope15(t, ejercicio, elegible) };
    } catch (e) {
      logger.warn('periodo.combustible_no_disponible', { err: e instanceof Error ? e.message : String(e) });
    }
    // `fundamentos` es el permiso de citar. `guardiaFundamento` le quita al
    // mensaje cualquier norma que no salga de aquí, así que esta lista es lo
    // único que el agente puede mencionar en este turno. Sin ella no puede
    // citar NADA, que es la posición segura.
    const fundamentos = normasDe(liq.diferencias.map((d) => d.tipo));
    // Si hay algo que decir del ejercicio, el agente puede citar la regla 2.9.
    if (periodo && periodo.estado !== 'holgado' && !fundamentos.includes('rfa-2026-2.9')) fundamentos.push('rfa-2026-2.9');
    return {
      total_comprobado: liq.totalComprobado,
      total_anticipo: liq.totalAnticipo,
      diferencia: liq.diferencia,
      estatus: liq.estatus,
      diferencias: liq.diferencias.map((d) => ({ tipo: d.tipo, monto: d.monto, nota: d.nota })),
      ...(periodo ? { combustible_efectivo_ejercicio: periodo } : {}),
      fundamentos: fundamentos.map((id) => ({
        norma_id: id,
        cita: NORMAS[id].citas[0],
        jerarquia: NORMAS[id].jerarquia,
        // Que el agente sepa si puede AFIRMAR o tiene que condicionar. Una ficha
        // sin verificar no sostiene una afirmación tajante.
        verificada: NORMAS[id].estado !== 'sin_verificar',
        vinculante: esVinculante(NORMAS[id].jerarquia),
      })),
    };
  },
});

// ── guardar_liquidacion (MUTACIÓN) ──────────────────────────────────────────
registerTool('guardar_liquidacion', {
  isMutation: true,
  schema: {
    type: 'function',
    function: {
      name: 'guardar_liquidacion',
      description: 'Cierra la liquidación del viaje: la persiste, genera el PDF y la marca como liquidada. Úsala solo cuando el operador confirme que ya no tiene más comprobantes.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  handler: async (_args, ctx) => {
    if (!ctx.viajeId) throw new Error('sin viaje activo');
    // ── DAT-22 · EL CIERRE LO PIDE EL OPERADOR, NO EL MODELO ────────────────
    //
    // Esta tool estaba disponible en TODOS los turnos, y es la única acción
    // irreversible del sistema: después de ella los triggers 0036/0037 bloquean
    // cualquier alta o corrección sobre el viaje. El único freno era el del
    // cierre EN CEROS (abajo), así que un viaje CON comprobantes se podía
    // cerrar en el turno de un "¿cuánto llevo?" — bastaba que el modelo se
    // adelantara— y el chofer se quedaba con el fajo en la mano y el viaje
    // cerrado.
    //
    // El candado vive AQUÍ, en la tool, por la misma razón que el del cierre en
    // ceros: el modelo es exactamente lo que hay que acotar, así que la
    // condición no puede depender de que él la respete. La marca la calcula el
    // processor sobre el texto del turno (`pidioCerrar`).
    //
    // Se lanza en vez de devolver un no-op: el error viaja al modelo como
    // resultado de la tool y él se lo explica al operador; un no-op silencioso
    // le haría creer al modelo que cerró y anunciarlo.
    if (ctx.cierrePedidoPorTexto !== true) {
      throw new Error(
        'el operador no pidió cerrar en este mensaje. La liquidación solo se '
        + 'cierra cuando él lo dice ("listo", "ya terminé", "ciérrala"). '
        + 'Contéstale lo que preguntó y pídele que escriba *listo* cuando ya no '
        + 'tenga más comprobantes.',
      );
    }
    // ── EL KILL SWITCH (0110), ANTES DE LA MUTACIÓN ─────────────────────────
    // Es el único punto por el que se CIERRA una liquidación, así que la
    // palanca `agente:liquidacion` vive aquí — no en `cuadrar_viaje`, que es
    // lectura y puede seguir contestando "¿cómo voy?" con el agente apagado.
    // El throw viaja como error de la tool (tool-executor lo atrapa) y el
    // modelo se lo explica al operador; los comprobantes ya recibidos no se
    // pierden. Fail-closed: si el interruptor no se puede LEER, `estaApagado`
    // devuelve apagado con grito en el log (ver interruptores.ts).
    if (await estaApagado('agente:liquidacion')) {
      throw new Error(
        'el agente de liquidación está apagado desde la consola de Likida. '
        + 'La liquidación no se puede cerrar hasta que lo enciendan; los comprobantes ya recibidos siguen guardados.',
      );
    }
    // La bitácora de corridas (0102 + 0115): `liquidacion` era el ÚNICO de
    // los 7 agentes vivos sin una sola fila en `agente_corrida`. Su corrida
    // es este cierre, y el disparo honesto es 'whatsapp' (0115): lo confirmó
    // el operador por chat, no un reloj ni un botón.
    const inicioCorrida = new Date();
    try {
      return await cerrarLiquidacion(ctx, inicioCorrida);
    } catch (e) {
      // `registrarCorrida` jamás lanza (estándar §7): anotar el fallo no
      // puede tapar el error real, que sigue subiendo al modelo tal cual.
      await registrarCorrida(ctx.tenantId, 'liquidacion', {
        inicio: inicioCorrida,
        fin: new Date(),
        estado: 'fallo',
        disparo: 'whatsapp',
        error: 'El cierre de la liquidación no se pudo completar. El detalle quedó en los registros del sistema.',
      });
      throw e;
    }
  },
});

/** El cuerpo real del cierre — separado para que el try del handler registre
 *  el fallo sin duplicar el camino feliz. El handler ya validó `viajeId`. */
async function cerrarLiquidacion(ctx: ToolContext, inicioCorrida: Date) {
  {
    // `liq` NO es const: si entre esta fotografía y el guardado entra un
    // comprobante, la base rechaza el cierre (CU003, 0158) y aquí se vuelve a
    // fotografiar UNA vez. Lo que se devuelve —y lo que la guardia del
    // processor narra por WhatsApp— tiene que ser la fotografía que de verdad
    // se archivó, nunca la primera.
    // El sello se toma ANTES de leer/calcultar. La RPC no confía en él: lo
    // recalcula bajo lock; su función es demostrar que todo lo que el motor y
    // los PDF leyeron sigue siendo exactamente lo que se va a persistir.
    let snapshot = await leerSnapshotInsumosCierre(ctx.tenantId, ctx.viajeId!);
    const [primerCuadre, viaje, operador] = await Promise.all([
      computeCuadre(ctx.tenantId, ctx.viajeId!, undefined, { modo: 'cierre' }),
      getViaje(ctx.viajeId!, ctx.tenantId),
      ctx.operadorId ? getOperador(ctx.operadorId, ctx.tenantId) : Promise.resolve(null),
    ]);
    let liq = primerCuadre;
    // ── EL CANDADO DEL CIERRE EN CEROS (QA 16-ago-2026, hallazgo crítico) ──
    // "Ya subí todo" sin una sola foto: `pareceCierre` no reconocía la frase,
    // el freno del processor nunca corría, y el LLM cerraba solo con
    // `total_comprobado: 0` — el anticipo ENTERO en contra del chofer,
    // irreversible por los triggers 0036/0037. Reproducido 5/6 con semilla
    // `2026-08-16|nivel3|operador|texto_sin_fotos|0`.
    //
    // El candado vive AQUÍ y no en la detección de frases porque la detección
    // es justo lo que el ataque esquiva: no importa qué diga el operador ni
    // qué decida el modelo — una liquidación sin comprobantes solo se cierra
    // con la confirmación expresa del freno (conv.cierreSinComprobantes, que
    // el processor pregunta UNA vez y el operador responde). El conteo sale
    // del MISMO cuadre que se va a persistir: cero consultas extra y cero
    // ventana entre lo contado y lo cerrado.
    const comprobantesReales = liq.gastos.filter((g) => g.monto > 0).length;
    if (comprobantesReales === 0 && ctx.cierreEnCerosConfirmado !== true) {
      throw new Error(
        'no hay ningún comprobante registrado en este viaje y cerrarlo así dejaría '
        + 'el anticipo completo en contra del operador, de forma irreversible. '
        + 'Pídele que mande sus fotos; si de verdad no trae comprobantes, que '
        + 'escriba "listo" para confirmar el cierre en ceros.',
      );
    }
    // Generar PDF (determinístico, sin LLM). DOS ejemplares, y no es redundancia:
    // el completo es el registro de la liquidación —lo que el contralor archiva y
    // lo que queda en `liquidacion.pdf_path`— y el del operador lleva el mismo
    // filtro que su mensaje de WhatsApp. Sin esta separación, la defensa de
    // `SOLO_CONTRALOR` en el texto no servía de nada: al chofer le llegaban los
    // veredictos por el adjunto, en un documento que además puede reenviar.
    let pdfPath: string | undefined;
    let pdfOperadorPath: string | undefined;
    // Los dos ejemplares se generan a partir de la fotografía QUE SE VA A
    // ARCHIVAR. Está en una función porque puede correr dos veces: si la base
    // rechaza el cierre por haber contado otros comprobantes (CU003, 0158),
    // reimprimir con la fotografía vieja archivaría el PDF que causó el
    // hallazgo. Se vuelve a fotografiar Y se vuelve a imprimir, o no se cierra.
    const generarPdfs = async (cuadre: Omit<Liquidacion, 'id' | 'creadaEn'>) => {
      // ── AUDITORÍA 22, BE-2 (ALTO): LAS RUTAS SE REINICIAN ────────────────
      // El comentario de arriba dice la intención: «reimprimir con la
      // fotografía vieja archivaría el PDF que causó el hallazgo». Pero
      // `pdfPath` y `pdfOperadorPath` viven FUERA y no se reiniciaban, así que
      // si la SEGUNDA impresión falla —el `catch` de abajo la registra y sigue—
      // las rutas de la PRIMERA sobreviven, `saveLiquidacion` archiva el PDF
      // del cuadre VIEJO y `sendDocument` se lo manda al chofer, todo
      // reportando éxito. O sea: exactamente lo que este bloque existe para
      // impedir, en el camino de excepción que lo motivó (CU003, 0158).
      //
      // `undefined` es la verdad cuando no hay papel nuevo: `saveLiquidacion`
      // y la corrida ya saben leerlo como «el cierre vale, falta el papel».
      pdfPath = undefined;
      pdfOperadorPath = undefined;
      try {
        // DAT-41: el id del papel es el que la fila va a tener (trigger de la
        // 0159), no uno inventado que nadie podría buscar después.
        const full: Liquidacion = { ...cuadre, id: idLiquidacionDeViaje(ctx.viajeId!), creadaEn: new Date().toISOString() };
        const v = viaje ?? { id: ctx.viajeId!, anticipo: cuadre.totalAnticipo };
        const o = operador ?? { id: ctx.operadorId ?? '', nombre: 'Operador', telefono: ctx.telefono ?? '' };
        const subir = async (bytes: Uint8Array, path: string) => {
          const up = await supabaseAdmin().storage.from('liquidaciones').upload(path, Buffer.from(bytes), {
            contentType: 'application/pdf',
            upsert: true,
          });
          if (up.error) { logger.warn('pdf.upload', { path, err: up.error.message }); return undefined; }
          return path;
        };
        // La razón social de la flota: encabeza el documento (el papel es suyo,
        // no nuestro) y nombra el descargo del pie. Se lee con catch → undefined
        // a propósito: si la consulta falla, el PDF sale con el encabezado
        // genérico en vez de NO SALIR. Perder la liquidación entera por no poder
        // leer un nombre sería el peor intercambio posible — y el fallback ya
        // está definido para no inventar ninguno.
        let razonSocial: string | undefined;
        try {
          const d = await getDatosFiscales(ctx.tenantId);
          razonSocial = d?.razonSocial ?? undefined;
        } catch (e) {
          logger.warn('pdf.razon_social', { err: e instanceof Error ? e.message : String(e) });
        }
        pdfPath = await subir(await generarLiquidacionPDF(full, v, o, razonSocial, 'contralor'), `${ctx.tenantId}/${ctx.viajeId}.pdf`);
        pdfOperadorPath = await subir(await generarLiquidacionPDF(full, v, o, razonSocial, 'operador'), `${ctx.tenantId}/${ctx.viajeId}-operador.pdf`);
      } catch (e) {
        logger.error('pdf.gen', { err: e instanceof Error ? e.message : String(e) });
      }
    };
    await generarPdfs(liq);

    // ── EL CIERRE, CON EL CONTEO QUE LA BASE TIENE QUE CONFIRMAR (DAT-02) ──
    //
    // `liq.gastos.length` es el número de comprobantes de la fotografía que
    // acaba de imprimirse. La 0158 toma el candado del viaje, cuenta los que
    // hay de verdad y se cae con CU003 si no coinciden: el papel y la base
    // nunca vuelven a contar distinto.
    //
    // El reintento es UNO y no un bucle a propósito. Una foto que entra justo
    // en esa ventana es un accidente; dos seguidas son un operador mandando
    // fajo mientras el agente cierra, y ahí lo correcto es NO cerrar y que el
    // processor se lo diga —volver a intentar sin fin le daría un cuadre
    // distinto cada vez, y el último no sería más verdadero que el primero.
    let liquidacionId: string;
    try {
      liquidacionId = await saveLiquidacion(ctx.tenantId, liq, pdfPath, liq.gastos.length, snapshot);
    } catch (e) {
      if (!insumosDeCierreCambiaron(e)) throw e;
      logger.warn('cierre.insumo_en_la_ventana', {
        tenantId: ctx.tenantId, viajeId: ctx.viajeId, gastosDelPrimerCuadre: liq.gastos.length,
      });
      // Segunda y última fotografía: cuadre nuevo, PDF nuevos, cierre nuevo.
      snapshot = await leerSnapshotInsumosCierre(ctx.tenantId, ctx.viajeId!);
      liq = await computeCuadre(ctx.tenantId, ctx.viajeId!, undefined, { modo: 'cierre' });
      await generarPdfs(liq);
      liquidacionId = await saveLiquidacion(ctx.tenantId, liq, pdfPath, liq.gastos.length, snapshot);
    }
    // ── LA CORRIDA SE ANOTA (0102 + 0115) ───────────────────────────────────
    // Después de persistir — la liquidación YA está cerrada — y con el
    // estándar §7: `registrarCorrida` jamás lanza, perder la anotación es mil
    // veces mejor que tumbar un cierre hecho. `parcial` cuando algún ejemplar
    // del PDF no subió: el cierre vale, pero a alguien le falta su papel.
    // Resumen con id y banderas, sin datos personales (regla de la 0102).
    await registrarCorrida(ctx.tenantId, 'liquidacion', {
      inicio: inicioCorrida,
      fin: new Date(),
      estado: pdfPath && pdfOperadorPath ? 'ok' : 'parcial',
      disparo: 'whatsapp',
      resumen: {
        liquidacionId,
        estatus: liq.estatus,
        pdfContralor: Boolean(pdfPath),
        pdfOperador: Boolean(pdfOperadorPath),
      },
      error: pdfPath && pdfOperadorPath
        ? undefined
        : 'La liquidación cerró, pero algún ejemplar del PDF no se pudo generar o subir.',
    });
    return {
      liquidacion_id: liquidacionId,
      estatus: liq.estatus,
      diferencia: liq.diferencia,
      pdf_generado: Boolean(pdfOperadorPath),
      // AUDITORÍA 8/9, MEDIO REINCIDENTE (backend): `pdf_generado` de arriba
      // solo refleja el ejemplar del OPERADOR (es lo que decide si se le
      // manda el PDF por WhatsApp, ver processor.ts). El del CONTRALOR —el
      // que decide la compra— podía fallar en silencio: `saveLiquidacion` ya
      // persiste `pdf_url = null` cuando `pdfPath` viene undefined, pero
      // nada aguas abajo se enteraba de CUÁL de los dos ejemplares faltaba.
      // Sin este campo, un fallo del upload del contralor con el del
      // operador exitoso pasaba exactamente igual que el camino feliz.
      pdf_contralor_generado: Boolean(pdfPath),
      // ── AUDITORÍA 7, CRÍTICO AG-3 — EL SNAPSHOT VIAJA CON EL RESULTADO ──────
      //
      // Esta `liq` es la MISMA que ya se imprimió en los dos PDF (arriba) y la
      // que se acaba de persistir en `saveLiquidacion`. Hasta ahora, ese número
      // se tiraba al volver de esta tool, y `guardiaCifras` volvía a llamar
      // `cuadrarDesdeDB` en OTRO momento para armar el texto de WhatsApp. Las
      // fotos entrantes NO toman mutex (processor.ts): un comprobante que entra
      // entre el cálculo de arriba y esa segunda lectura hace que el PDF
      // archivado y el WhatsApp narren DOS cuadres distintos del MISMO cierre.
      //
      // Se manda el snapshot completo para que la guardia lo REUSE en vez de
      // recalcular — el mismo principio que ya aplica el resto del sistema: una
      // sola fotografía de la verdad por cierre, nunca dos.
      liq,
    };
  }
}
