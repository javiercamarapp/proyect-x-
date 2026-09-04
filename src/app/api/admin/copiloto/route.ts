import { leerTextoAcotado } from '@/lib/http/cuerpo_acotado';
// ═══════════════════════════════════════════════════════════════════════════
// EL ENDPOINT DEL COPILOTO DEL FUNDADOR — /api/admin/copiloto.
//
// LA PUERTA SE RE-CHEQUEA AQUÍ (mismo criterio que api/admin/palette): las
// rutas /api no pasan por el layout de /admin — este archivo es su propia
// puerta, y detrás hay lecturas cross-tenant con service role MÁS gasto de
// modelo por llamada. Sin sesión: 401. Otro rol: 403. Ninguna dice qué hay.
//
// DOS OPERACIONES, un discriminador en el cuerpo:
//  · { mensajes }            → el chat (streaming NDJSON, como /dashboard/chat).
//    Con `conversacionId` opcional: cada intercambio se persiste (0121) y el
//    'fin' devuelve el id — la lista y la lectura viven en ./conversaciones.
//    Si la respuesta trae un bloque `accion` implementada, el SERVIDOR crea
//    un AdminActionIntent (copiloto-intents.ts) y el bloque viaja con su
//    `intentId` — esa es la única llave que después ejecuta.
//  · { intentId, accion }    → EJECUTAR presentando el intent que ESTE
//    servidor creó al proponer. Ya NO existe `confirmado: true` como
//    autoridad: el intent se valida (existe, no usado, no expirado, mismo
//    actor, mismos args) y se gasta — inválido/expirado es 409. Las acciones
//    `gateo: 'doble'` exigen motivo y DOS POSTs con el mismo intent (armar →
//    ejecutar); las 'confirma' ejecutan con uno. Determinista, sin modelo
//    (copiloto-acciones.ts).
//
// COSTO: cada completion reserva y liquida contra el ledger monetario central
// (0186), además del log por turno (`copiloto.costo`). El tenant de cobro sale
// EXCLUSIVAMENTE de la sesión: si el superadmin no tiene uno asignado, el chat
// falla cerrado antes del modelo. No existe fallback por env ni tenant de
// relleno. `llm_costo` sigue siendo la telemetría operativa de las flotas;
// `llm_presupuesto_reserva` es la frontera dura de gasto compartida.
// ═══════════════════════════════════════════════════════════════════════════
import { NextResponse } from 'next/server';
import { rateLimit } from '@/lib/ratelimit';
import { ejecutarCopiloto, type BloqueCopiloto, type BloqueAccion } from '@/lib/agents/copiloto';
import { ejecutarAccionCopiloto } from '@/lib/agents/copiloto-acciones';
import { crearIntent, reclamarIntent, hashArgsAccion } from '@/lib/agents/copiloto-intents';
import { guardarIntercambioCopiloto } from '@/lib/agents/copiloto-historial';
import { validarConversacionId } from '@/app/api/dashboard/chat/validacion';
import { DatoInvalido } from '@/lib/likida/errores';
import { logger } from '@/lib/logger';
import { sesionSuperadmin } from './puerta';
import { registrarEventoSeguridad } from '@/lib/seguridad/eventos';
import { estaApagado } from '@/lib/likida/interruptores';
import { supabaseServer } from '@/lib/supabase/server';
import { exigirAal2SiHayFactor, MSG_STEP_UP, MSG_MFA_NO_VERIFICABLE } from '@/lib/auth/mfa';
import { CATALOGO_ACCIONES } from '@/lib/agents/copiloto-acciones';
import { PartialExecutionError } from '@/lib/llm/openrouter';
import { vieneDeNuestroSitio } from '@/lib/auth/csrf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Historial acotado (mismos topes que valida /dashboard/chat): 12 turnos,
 *  2,000 chars cada uno — el cliente no es frontera de confianza. */
function validarMensajes(crudo: unknown): Array<{ rol: 'usuario' | 'asistente'; texto: string }> | null {
  if (!Array.isArray(crudo) || crudo.length === 0 || crudo.length > 24) return null;
  const out: Array<{ rol: 'usuario' | 'asistente'; texto: string }> = [];
  for (const m of crudo.slice(-24)) {
    const rol = (m as { rol?: unknown })?.rol;
    const texto = (m as { texto?: unknown })?.texto;
    if ((rol !== 'usuario' && rol !== 'asistente') || typeof texto !== 'string' || !texto.trim()) return null;
    out.push({ rol, texto: texto.trim().slice(0, 2000) });
  }
  if (out[out.length - 1].rol !== 'usuario') return null;
  return out;
}

/** Defensa adicional por TURNOS del copiloto. El ledger 0186 pone el techo
 *  monetario atómico; este rate limit corta antes los bucles o una sesión
 *  secuestrada: 300/día ≈ un día pesado de dirección con margen.
 *  Override: LIKIDA_COPILOTO_TOPE_TURNOS_DIA. */
function topeTurnosDia(): number {
  const v = Number(process.env.LIKIDA_COPILOTO_TOPE_TURNOS_DIA);
  return Number.isFinite(v) && v > 0 ? v : 300;
}
const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * M23 (auditoría 18): el único reloj del POST vivía DENTRO del motor (40 s) y
 * no cubría nada de lo que va después — crear los intents y las tres
 * escrituras en serie del historial. Sumados, los techos daban 81 s contra
 * `maxDuration = 60`: con el modelo a 38 s y una escritura lenta, Vercel
 * cortaba el stream ANTES de `manda({t:'fin'})` y la interfaz se quedaba
 * pintando el último "paso" para siempre, con el turno ya cobrado.
 *
 * Presupuesto del borde: 40 s modelo + 5 s intents + 8 s historial = 53 s,
 * con margen para la puerta y el rate limit. Lo que no cabe se DICE y se
 * salta: el historial es comodidad, la respuesta ya costó dinero.
 */
const PLAZO_INTENTS_MS = 5_000;
function plazoHistorialMs(): number {
  const v = Number(process.env.LIKIDA_COPILOTO_PLAZO_HISTORIAL_MS);
  return Number.isFinite(v) && v > 0 ? v : 8_000;
}
function conPlazo<T>(p: Promise<T>, ms: number, etiqueta: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reloj = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${etiqueta}: se agotó el plazo de ${ms} ms`)), ms);
  });
  return Promise.race([p, reloj]).finally(() => clearTimeout(timer));
}

export async function POST(req: Request) {
  // ── DE DÓNDE VIENE, ANTES DE QUIÉN ES (auditoría 21 — BAJO-MEDIO: el
  // chequeo ya existía en /api/admin/palette y no se generalizó al resto de
  // escrituras cookie-autenticadas). Esta es la más sensible de todas: ejecuta
  // acciones administrativas (algunas 'doble' + MFA) y gasta dinero de modelo
  // por turno. Va ANTES de la sesión, a propósito: a una petición de otro
  // sitio no se le contesta si el usuario es superadmin o no.
  if (!vieneDeNuestroSitio(req)) {
    logger.warn('copiloto.origen_ajeno', {
      origen: req.headers.get('origin'), sitio: req.headers.get('sec-fetch-site'),
    });
    return NextResponse.json({ error: 'Petición de otro sitio.' }, { status: 403 });
  }

  const { error: puerta, sesion } = await sesionSuperadmin();
  if (!sesion) return puerta;

  // La palanca del copiloto (0250, tableros al día): gasto de modelo por
  // llamada + ejecución de acciones administrativas = la interfaz de mando
  // también tiene que poderse callar con un click, no con un deploy. Se
  // enciende desde Observabilidad o el ⌘K — esa puerta no pasa por aquí.
  // Fail-closed heredado de `estaApagado`: palanca ilegible = apagado.
  if (await estaApagado('agente:copiloto')) {
    return NextResponse.json({
      error: 'El copiloto está apagado (palanca agente:copiloto). Se enciende desde Observabilidad o el ⌘K.',
    }, { status: 503 });
  }

  // La cuota corta es común a chat y acciones; el turno diario sólo se cobra al chat.
  if (!(await rateLimit(`copiloto:min:${sesion.userId}`, 20, 60_000))) {
    return NextResponse.json({ error: 'tope por minuto del copiloto (20/min) — espera un momento' }, { status: 429 });
  }
  // 24 turnos de 2,000 caracteres, incluso escapados en JSON, más envoltura.
  const lecturaCuerpo = await leerTextoAcotado(req, 512 * 1024);
  if (!lecturaCuerpo.ok) return NextResponse.json({ error: lecturaCuerpo.motivo === 'demasiado_grande' ? 'payload muy grande' : 'JSON inválido' },
    { status: lecturaCuerpo.motivo === 'demasiado_grande' ? 413 : 400 });
  let cuerpo: Record<string, unknown>;
  try {
    const valor: unknown = JSON.parse(lecturaCuerpo.texto);
    if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return NextResponse.json({ error: 'Se esperaba un objeto JSON.' }, { status: 400 });
    cuerpo = valor as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  // ── Camino 2: ejecutar una acción con su INTENT (sin modelo, sin stream) ─
  if (cuerpo.accion !== undefined || cuerpo.intentId !== undefined) {
    // Las acciones no consumen LLM ni presupuesto diario de turnos, pero sí
    // conservan el freno corto contra replay/bucles de cliente.
    const a = cuerpo.accion as { id?: unknown; objetivo?: unknown; motivo?: unknown } | null;
    const accionId = typeof a?.id === 'string' ? a.id : '';
    const objetivo = typeof a?.objetivo === 'string' ? a.objetivo : '';
    const motivo = typeof a?.motivo === 'string' ? a.motivo : undefined;
    // La regla del diseño §5.3, versión intent: ninguna acción sin la llave
    // que ESTE servidor emitió al proponer. Un `confirmado: true` del
    // cliente ya no pinta nada — el booleano dejó de ser la autoridad.
    const intentId = typeof cuerpo.intentId === 'string' ? cuerpo.intentId : '';
    if (!intentId) {
      return NextResponse.json({
        error: 'La acción llegó sin un intent del servidor — pide la acción al copiloto y confirma desde su previsualización.',
      }, { status: 409 });
    }
    // ── STEP-UP (fase 7): una acción 'doble' de un usuario CON segundo
    // factor exige la sesión en AAL2 — ANTES de tocar el intent, para no
    // gastarlo en un intento que va a rebotar. Sin factor inscrito pasa
    // (política incremental de lib/auth/mfa.ts).
    const defAccion = CATALOGO_ACCIONES.find((x) => x.id === accionId);
    if (defAccion?.gateo === 'doble') {
      const paso = await exigirAal2SiHayFactor(await supabaseServer());
      if (!paso.ok) {
        void registrarEventoSeguridad({ origen: 'copiloto', tipo: 'step_up_rechazado', severidad: 'info', actor: sesion.userId, detalle: { accion: accionId, motivo: paso.motivo } });
        // `no_verificable` (B14): Supabase Auth no contestó — se rechaza igual
        // (fallar cerrado), pero se le dice al usuario que reintente, no que
        // verifique un código que quizá no tiene.
        return NextResponse.json({ error: paso.motivo === 'verificar' ? MSG_STEP_UP : MSG_MFA_NO_VERIFICABLE }, { status: 403 });
      }
    }
    const reclamo = await reclamarIntent({
      intentId,
      actorId: sesion.userId,
      argsHash: hashArgsAccion(accionId, objetivo),
      motivo,
    });
    if (!reclamo.ok) {
      // 'motivo' es validación de entrada (400); lo demás es un intent que
      // ya no autoriza nada (409) — y en ambos se dice qué hacer. El 409 es
      // señal de T&S: replay, otro actor o args cambiados.
      if (reclamo.codigo !== 'motivo') {
        void registrarEventoSeguridad({ origen: 'copiloto', tipo: 'intent_invalido', actor: sesion.userId, detalle: { accion: accionId, codigo: reclamo.codigo } });
      }
      return NextResponse.json({ error: reclamo.error }, { status: reclamo.codigo === 'motivo' ? 400 : 409 });
    }
    if (reclamo.fase === 'armado') {
      // 'doble': primer POST válido. NO ejecutó — falta repetir el POST con
      // el mismo intentId para gastar el intent.
      return NextResponse.json({
        ok: true,
        armado: true,
        mensaje: 'Primera confirmación registrada. Confirma de nuevo para ejecutar — esta acción exige doble confirmación.',
      });
    }
    try {
      const r = await ejecutarAccionCopiloto(accionId, {
        id: objetivo || undefined,
        motivo: reclamo.motivo ?? undefined,
      }, sesion.userId);
      return NextResponse.json(r);
    } catch (e) {
      // El intent ya se gastó: un fallo aquí NO deja una llave viva para
      // reintentar a ciegas — se re-propone (fallar cerrado, sin replay).
      if (e instanceof DatoInvalido) return NextResponse.json({ error: e.message }, { status: 400 });
      logger.error('copiloto.accion_fallo', { accion: accionId, err: e instanceof Error ? e.message : String(e) });
      return NextResponse.json({ error: 'No se pudo ejecutar la acción. El detalle quedó en los registros.' }, { status: 500 });
    }
  }

  // ── Camino 1: el chat (streaming NDJSON, patrón de /dashboard/chat) ──────
  const mensajes = validarMensajes(cuerpo.mensajes);
  if (!mensajes) return NextResponse.json({ error: 'mensajes inválidos' }, { status: 400 });
  // El commit 0c5d3de elimina deliberadamente el tenant global por env. Esta
  // comprobación hace el fail-closed visible ANTES del turno diario y del
  // stream: no se cobra un turno de chat ni se devuelve un NDJSON condenado.
  if (!sesion.tenantId) {
    logger.warn('copiloto.presupuesto_sin_tenant', { userId: sesion.userId });
    return NextResponse.json({
      error: 'El Copiloto requiere un tenant explícito de presupuesto asignado a la sesión superadmin.',
      codigo: 'copiloto_presupuesto_sin_tenant',
    }, { status: 503 });
  }
  // Techo diario exclusivo del chat. La cuota común por minuto ya pasó.
  // El ledger 0186 aplica además el límite monetario atómico.
  if (!(await rateLimit(`copiloto:dia:${sesion.userId}`, topeTurnosDia(), DIA_MS))) {
    return NextResponse.json({ error: `tope diario del copiloto (${topeTurnosDia()} turnos) — sube LIKIDA_COPILOTO_TOPE_TURNOS_DIA si es a propósito` }, { status: 429 });
  }
  // El id de conversación al que anexar (historial 0121). Inválido o ajeno →
  // conversación nueva, jamás la de otro (el anclaje vive en el módulo).
  const conversacionPedida = validarConversacionId(cuerpo.conversacionId);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controlador) {
      const manda = (ev: unknown) => {
        try { controlador.enqueue(encoder.encode(`${JSON.stringify(ev)}\n`)); } catch { /* cliente cerró */ }
      };
      try {
        const r = await ejecutarCopiloto({
          userId: sesion.userId,
          // Ya estrechado arriba: proviene de la sesión autenticada y nunca
          // de un env global ni de un tenant de relleno.
          budgetTenantId: sesion.tenantId,
          mensajes,
          onPaso: (p) => manda({ t: 'paso', fase: p.fase, tool: p.tool }),
        });
        // EL INTENT NACE AL PROPONER (copiloto-intents.ts): cada bloque
        // `accion` implementada sale con el `intentId` que el servidor acaba
        // de crear para ESTA sesión — la única llave que después ejecuta. Las
        // no implementadas no llevan intent: no hay nada que autorizar.
        type BloqueConIntent = BloqueCopiloto | (BloqueAccion & { intentId: string });
        // El costo se anota ANTES de los intents y el historial: lo que sigue
        // puede fallar o agotar su plazo, y el turno ya se pagó.
        logger.info('copiloto.costo', {
          costoUsd: r.costoUsd, tokensIn: r.tokensIn, tokensOut: r.tokensOut,
          modelo: r.modelo, tools: r.toolsUsadas.length,
        });
        let bloques: BloqueConIntent[];
        try {
          bloques = await conPlazo(Promise.all(r.bloques.map(async (b) => (
            b.tipo === 'accion' && b.implementada
              ? { ...b, intentId: (await crearIntent({ actorId: sesion.userId, accion: b.accion, objetivo: b.objetivo, gateo: b.gateo })).id }
              : b
          ))), PLAZO_INTENTS_MS, 'copiloto.intents');
        } catch (err) {
          // Sin intent no hay acción ejecutable: se ENTREGA la respuesta sin
          // la tarjeta y se dice por qué, en vez de colgar el stream o pintar
          // un botón que va a rebotar con 409.
          logger.error('copiloto.intent_fallo', { err: err instanceof Error ? err.message : String(err) });
          bloques = [
            ...r.bloques.filter((b) => b.tipo !== 'accion'),
            { tipo: 'texto', texto: 'No alcancé a preparar la acción propuesta — pídemela de nuevo y la armo.' },
          ];
        }
        // Persistir el intercambio (0121). Si falla O SE TARDA, la respuesta
        // IGUAL sale — el historial es una comodidad; la respuesta ya costó
        // dinero. El plazo es el que hace verdadera esa frase también para
        // un cuelgue, no solo para un throw.
        let conversacionId: string | null = null;
        try {
          conversacionId = await conPlazo(guardarIntercambioCopiloto({
            userId: sesion.userId,
            conversacionId: conversacionPedida,
            pregunta: mensajes[mensajes.length - 1].texto,
            textoRespuesta: bloques
              .filter((b): b is { tipo: 'texto'; texto: string } => b.tipo === 'texto' && typeof (b as { texto?: unknown }).texto === 'string')
              .map((b) => b.texto).join(' ') || 'Listo.',
            // Con intentId incluido — inofensivo en el historial: las
            // reaperturas se pintan ARCHIVADAS y el intent expira en 2 min.
            bloques: bloques as unknown as Array<Record<string, unknown>>,
          }), plazoHistorialMs(), 'copiloto.historial');
        } catch (err) {
          logger.error('copiloto.guardar_fallo', { err: err instanceof Error ? err.message : String(err) });
        }
        manda({ t: 'fin', bloques, toolsUsadas: r.toolsUsadas, conversacionId });
      } catch (err) {
        // M29 (auditoría 18): el turno que truena (loop-guard, abort de 40 s,
        // truncamiento) YA PAGÓ sus completions y el consumo viaja en
        // PartialExecutionError. Sin esta línea el único medidor del gasto
        // propio de Likida en IA de dirección quedaba ciego justo en los
        // turnos caros. Mismo criterio que /api/dashboard/chat (TC-A1).
        if (err instanceof PartialExecutionError && (err.tokensIn > 0 || err.tokensOut > 0)) {
          logger.info('copiloto.costo', {
            costoUsd: err.cost, tokensIn: err.tokensIn, tokensOut: err.tokensOut,
            modelo: 'parcial', tools: err.partialToolCalls.length, fallo: true,
          });
        }
        logger.error('copiloto.fallo', { err: err instanceof Error ? err.message : String(err) });
        manda({ t: 'error', error: 'el copiloto no pudo responder en este momento' });
      } finally {
        try { controlador.close(); } catch { /* ya cerrado */ }
      }
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
