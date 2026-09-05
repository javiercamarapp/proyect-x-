// El endpoint del agente analista — "Pregunta a tus datos" (12-ago-2026).
//
// Autorización calcada de /api/dashboard/asistente e ingesta (el matcher del
// proxy excluye /api: esta línea es la única puerta, y el mismo IDOR que se
// cerró allá aplica aquí — esto lee dinero de TODA la flota con service role
// y además GASTA en el modelo por llamada).
//
// ANTI-QUEMADURA (pedido explícito: "que no implique que si se quedan ahí
// todo el día quemar un exceso de tokens"), tres capas:
//  1. Por turno: 5 rondas de tools + 900 tokens de salida (analista.ts).
//  2. Por petición: historial recortado a 12 turnos / 2,000 chars cada uno.
//  3. POR DÍA Y POR TENANT: tope en USD contra `llm_costo` (fase chat, hoy
//     en America/Mexico_City). Agotado, el endpoint responde `agotado:true`
//     y el cliente degrada al respondedor gratis — el chat nunca queda mudo.
import { NextResponse, type NextRequest } from 'next/server';
import { getSessionTenant } from '@/lib/auth/session';
import { rechazoMfaSuperadminApi } from '@/lib/auth/api-superadmin';
import { puedeVerArea } from '@/lib/auth/visibilidad';
import { registrarCosto, faseDeModelo } from '@/lib/likida/costos';
import { PartialExecutionError } from '@/lib/llm/openrouter';
import { guardarIntercambio } from '@/lib/likida/chat/conversaciones';
import { ejecutarAnalista } from '@/lib/agents/analista';
import { logger } from '@/lib/logger';
import { codigoDeError } from '@/lib/observability/sentry';
import { rateLimit } from '@/lib/ratelimit';
import { validarMensajes, validarConversacionId } from './validacion';
import { topeDiaUsd, gastoChatHoyUsd } from './tope';
import { tenantEfectivoChat } from './tenant';
import { vieneDeNuestroSitio } from '@/lib/auth/csrf';
import { leerTextoAcotado } from '@/lib/http/cuerpo_acotado';
import { MAX_CHAT_BYTES } from './limites';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// BE-20 (auditoría 24): era la única ruta cara del panel sin límite de tasa.
// El tope diario se lee ANTES de la completion y el costo se registra
// DESPUÉS, así que 40 POST en paralelo con `gastadoHoy = $0` pasaban los 40 y
// gastaban ~$2 contra un tope de $1, con 40 streams de 60 s. Diez turnos por
// minuto por usuario le sobran a una persona escribiendo (un turno tarda
// 5-40 s en contestar) y acotan la ráfaga a lo que el tope diario sí alcanza
// a ver. Mismo patrón que `onboarding-chat`, `ingesta` y `archivo`.
const TURNOS_POR_MINUTO = 10;

export async function POST(req: NextRequest) {
  // Auditoría 21, BAJO-MEDIO: el chequeo CSRF explícito (SEG-9) solo cubría
  // /api/admin/palette y /v1/*. Esta ruta escribe (guarda el intercambio) y
  // gasta dinero de modelo, autenticada solo por la cookie de sesión.
  if (!vieneDeNuestroSitio(req)) {
    logger.warn('chat.origen_ajeno', { origen: req.headers.get('origin'), sitio: req.headers.get('sec-fetch-site') });
    return NextResponse.json({ error: 'Petición de otro sitio.' }, { status: 403 });
  }

  const sesion = await getSessionTenant();
  if (!sesion) return NextResponse.json({ error: 'sin sesion' }, { status: 401 });
  const rechazoMfa = await rechazoMfaSuperadminApi(sesion);
  if (rechazoMfa) return rechazoMfa;
  if (!puedeVerArea(sesion.rol, 'dinero')) {
    return NextResponse.json({ error: 'sin acceso' }, { status: 403 });
  }
  if (!(await rateLimit(`chat:${sesion.userId}`, TURNOS_POR_MINUTO, 60_000))) {
    return NextResponse.json({ error: 'Demasiadas preguntas seguidas; espera un momento.' }, { status: 429 });
  }

  // Tenant efectivo + nombre de flota: regla COMPARTIDA con /conversaciones
  // (tenant.ts) — dos copias de una regla de autorización se desincronizan.
  const efectivo = await tenantEfectivoChat(sesion, req.nextUrl.searchParams.get('tenant'));
  // AUDITORÍA 24 (auth): `null` con `?tenant=` presente es "no se pudo
  // verificar la flota" (lectura caída), no "sin permiso" — 503, como
  // `resolverTenantApi`. Sin `?tenant=` sigue siendo 403 real.
  if (!efectivo) return NextResponse.json({ error: 'sin acceso' },
    { status: req.nextUrl.searchParams.get('tenant') ? 503 : 403 });
  const { tenantId, nombreFlota } = efectivo;

  const lectura = await leerTextoAcotado(req, MAX_CHAT_BYTES);
  if (!lectura.ok) return NextResponse.json({ error: lectura.motivo === 'demasiado_grande' ? 'cuerpo demasiado grande' : 'cuerpo inválido' },
    { status: lectura.motivo === 'demasiado_grande' ? 413 : 400 });
  let cuerpo: unknown;
  try { cuerpo = JSON.parse(lectura.texto); } catch { return NextResponse.json({ error: 'cuerpo inválido' }, { status: 400 }); }
  const mensajes = validarMensajes((cuerpo as { mensajes?: unknown })?.mensajes);
  if (!mensajes) return NextResponse.json({ error: 'mensajes inválidos' }, { status: 400 });
  // El id de conversación al que anexar (historial 0088). Inválido o ajeno →
  // conversación nueva; nunca un error que le corte la respuesta al usuario.
  const conversacionPedida = validarConversacionId((cuerpo as { conversacionId?: unknown })?.conversacionId);

  // El documento adjunto (si hay): extracto YA acotado por /archivo, pero
  // aquí se re-recorta — el cliente no es frontera de confianza.
  const docCrudo = (cuerpo as { documento?: { nombre?: unknown; extracto?: unknown } | null })?.documento;
  const documento = docCrudo && typeof docCrudo.nombre === 'string' && typeof docCrudo.extracto === 'string' && docCrudo.extracto.trim()
    ? { nombre: docCrudo.nombre.trim().slice(0, 120), extracto: docCrudo.extracto.slice(0, 16_000) }
    : null;

  // ── Tope diario ── (la lectura vive en ./tope.ts, compartida con el
  // widget de uso del sidebar: el freno y el widget miran el MISMO número.)
  let gastadoHoy: number;
  try {
    gastadoHoy = await gastoChatHoyUsd(tenantId);
  } catch (e) {
    // Fallar CERRADO: si no se pudo leer el gasto del día, no se gasta más.
    logger.error('chat.tope_dia.error', { err: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ agotado: true, bloques: [{ tipo: 'texto', texto: 'No pude verificar el presupuesto del día — el análisis con IA descansa un momento. Las respuestas rápidas siguen funcionando.' }] });
  }
  if (gastadoHoy >= topeDiaUsd()) {
    return NextResponse.json({
      agotado: true,
      bloques: [{ tipo: 'texto', texto: 'El análisis con IA de hoy llegó a su tope diario (existe para cuidar tu costo). Mañana se renueva solo; mientras, las respuestas rápidas del catálogo siguen funcionando.' }],
    });
  }

  // ── STREAMING (13-ago-2026): la secuencia de pensamiento EN VIVO ─────────
  // Cada tool que el agente ejecuta viaja como un evento NDJSON en cuanto
  // arranca y en cuanto termina — pasos REALES del ciclo, no una animación.
  // El último evento trae los bloques (o el error); los caminos de tope de
  // arriba siguen contestando JSON plano y el cliente entiende ambos.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controlador) {
      const manda = (ev: unknown) => {
        try { controlador.enqueue(encoder.encode(`${JSON.stringify(ev)}\n`)); } catch { /* cliente cerró */ }
      };
      try {
        const r = await ejecutarAnalista({
          tenantId, nombreFlota, usuario: { nombre: sesion.nombre, rol: sesion.rol }, documento, mensajes,
          onPaso: (p) => manda({ t: 'paso', fase: p.fase, tool: p.tool }),
        });
        // El costo se registra POR MODELO real (mismo criterio que
        // processor.ts): una sola etiqueta miente cuando hubo fallback.
        for (const [modelo, c] of Object.entries(r.costoPorModelo)) {
          await registrarCosto({
            tenantId, viajeId: null, fase: faseDeModelo(modelo, 'chat'), modelo,
            tokensIn: c.tokensIn, tokensOut: c.tokensOut, costoUsd: c.cost,
          });
        }
        // Persistir el intercambio (0088). Si falla, la respuesta IGUAL sale.
        let conversacionId: string | null = null;
        try {
          conversacionId = await guardarIntercambio({
            tenantId,
            userId: sesion.userId,
            conversacionId: conversacionPedida,
            pregunta: mensajes[mensajes.length - 1].texto,
            textoRespuesta: r.bloques
              .filter((b): b is { tipo: 'texto'; texto: string } => b.tipo === 'texto' && typeof (b as { texto?: unknown }).texto === 'string')
              .map((b) => b.texto).join(' ') || 'Listo.',
            bloques: r.bloques as unknown as Array<Record<string, unknown>>,
          });
        } catch (err) {
          logger.error('chat.guardar.fallo', { err: err instanceof Error ? err.message : String(err) });
        }
        manda({ t: 'fin', bloques: r.bloques, conversacionId });
      } catch (err) {
        // AUDITORÍA 3, TC-A1 (ALTO): el turno que truena (loop-guard, timeout
        // de 40s, truncamiento) YA PAGÓ hasta 9 completions y su consumo
        // viaja en PartialExecutionError — tirarlo dejaba al tope diario de
        // $1/tenant ciego exactamente al modo de falla que más gasta. Mismo
        // criterio que processor.ts: se registra como modelo 'parcial'.
        if (err instanceof PartialExecutionError && (err.tokensIn > 0 || err.tokensOut > 0)) {
          try {
            await registrarCosto({
              tenantId, viajeId: null, fase: 'chat', modelo: 'parcial',
              tokensIn: err.tokensIn, tokensOut: err.tokensOut, costoUsd: err.cost,
            });
          } catch (e2) {
            logger.error('chat.costo_parcial_sin_registrar', { tenantId, err: e2 instanceof Error ? e2.message : String(e2) });
          }
        }
        logger.error('chat.analista.fallo', {
          tenantId, ruta: '/api/dashboard/chat',
          codigo: codigoDeError(err instanceof PartialExecutionError ? err.cause ?? err : err),
          err: err instanceof Error ? err.message : String(err),
        });
        manda({ t: 'error', error: 'el analista no pudo responder en este momento' });
      } finally {
        try { controlador.close(); } catch { /* ya cerrado */ }
      }
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
