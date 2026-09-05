import { leerTextoAcotado } from '@/lib/http/cuerpo_acotado';
// ═══════════════════════════════════════════════════════════════════════════
// EL AGENTE EXPERTO EN MENSAJES — POST /api/admin/mapa-prospectos/mensaje
//
// Recibe {id} y redacta el primer toque (WhatsApp + correo) con TODA la info
// del prospecto: empresa, decisor, la CAUSA (su vacante textual, su giro, su
// plaza, el dolor de las notas del censo/ficha). Escribe el resultado a las
// columnas de la 0129 y lo devuelve — el botón del Cerebro abre con esto.
//
// Modelo: rol `marketing` de models.ts (hoy gpt-5.6-luna, ~$0.10/M — stack
// 100% USA, regla legal). El costo por mensaje es ~décimas de centavo y se
// registra en el ledger transaccional de presupuesto del tenant explícito
// de la sesión superadmin. Sin tenant no se llama al proveedor: el control
// de gasto falla cerrado y nunca cae en un presupuesto global implícito.
// ═══════════════════════════════════════════════════════════════════════════
import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { generateStructured } from '@/lib/llm/openrouter';
import { createLlmBudget } from '@/lib/llm/budget';
import { giroDe, NOMBRE_GIRO } from '@/lib/admin/prospectos-mapa';
import { pieAvisoProspectos } from '@/lib/likida/privacidad';
import { normalizarEstadoProspecto } from '@/lib/likida/vendedores';
// La PUERTA ÚNICA de datos de persona hacia el modelo (auditoría 19, legal
// C2 / C.18): vive en lib/likida/prospectos para que TODO camino que arme un
// prompt con datos de un prospecto pase por la misma puerta — este y el
// Redactor de correos fríos. seudonimo_puerta_unica.test.ts lo vigila.
import { lineaDecisor, notasSinPersona, reponerDecisor, MARCADOR_DECISOR } from '@/lib/likida/prospectos/seudonimo';
import { rateLimit } from '@/lib/ratelimit';
import { logger } from '@/lib/logger';
import { sesionSuperadmin } from '../puerta';
import { vieneDeNuestroSitio } from '@/lib/auth/csrf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Salida = z.object({
  mensaje_wa: z.string().min(40).max(600),
  correo_asunto: z.string().min(6).max(90),
  correo_cuerpo: z.string().min(80).max(1400),
});

const SYSTEM = `Eres el redactor de primeros toques B2B de Likida.ai (liquidación de viajes de flotas por WhatsApp, México). Escribes en español mexicano, directo y profesional — tono norteño de negocios, cero humo.

Reglas DURAS (violarlas invalida el mensaje):
- Likida NO tiene clientes todavía: jamás "nuestros clientes"; el framing es "estamos eligiendo a las primeras flotas".
- Cifras SOLO canónicas — no inventes ninguna otra: $35 por viaje (tabulador por volumen $38 / $35 / $31.25), ciclo manual ~$105 por viaje. El diésel SOLO se habla en litros elegibles; JAMÁS en pesos del estímulo — esa es la línea que no se cruza (es materia fiscal delicada, litros sí, pesos del estímulo no).
- La PERSONALIZACIÓN es la causa del mensaje: si hay vacante publicada, se cita textual y es el gancho ("vi que buscan X — ese trabajo es el que automatizamos"); si no, el gancho es su giro y su plaza. Si el decisor está identificado, se le habla a él de usted y donde iría su nombre de pila se escribe LITERALMENTE el marcador ${MARCADOR_DECISOR} (se sustituye después). Jamás inventes ni adivines un nombre de persona.
- Qué hace Likida (esto sí, en una línea): el operador manda sus comprobantes por WhatsApp y la liquidación sale cuadrada, con lo fiscal separado y su PDF; el número lo calcula un motor, no una IA.
- CTA única: 15 minutos esta semana.
- WhatsApp: máximo 6 líneas, sin saludos largos. Correo: máximo 120 palabras, asunto anclado al gancho (nunca "Propuesta comercial"), firma "Javier Cámara — Likida.ai".
- Nada de emojis en el correo; en WhatsApp máximo uno.`;

export async function POST(req: Request) {
  // Auditoría 21, BAJO-MEDIO: el chequeo CSRF explícito (SEG-9) solo cubría
  // /api/admin/palette y /v1/*. Escribe la ficha del prospecto y gasta
  // dinero de modelo — autenticada solo por cookie de sesión.
  if (!vieneDeNuestroSitio(req)) {
    logger.warn('cerebro.mensaje_origen_ajeno', { origen: req.headers.get('origin'), sitio: req.headers.get('sec-fetch-site') });
    return NextResponse.json({ error: 'Petición de otro sitio.' }, { status: 403 });
  }

  const { error, sesion } = await sesionSuperadmin();
  if (error) return error;
  if (!sesion.tenantId) {
    logger.warn('cerebro.presupuesto_sin_tenant', { userId: sesion.userId });
    return NextResponse.json({
      error: 'El redactor requiere un tenant explícito de presupuesto asignado a la sesión superadmin.',
      codigo: 'redactor_presupuesto_sin_tenant',
    }, { status: 503 });
  }
  // Techo de ráfaga, no de negocio: 120/hora cubre una sesión intensa de
  // prospección y frena un loop de UI descontrolado.
  if (!(await rateLimit('cerebro:mensaje', 120, 3_600_000))) {
    return NextResponse.json({ error: 'Tope de generación por hora alcanzado — respira y vuelve.' }, { status: 429 });
  }

  // Un UUID y envoltura; el mensaje se construye en el servidor.
  const lecturaCuerpo = await leerTextoAcotado(req, 8 * 1024);
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
  const id = cuerpo?.id;
  if (typeof id !== 'string' || !id || !/^[0-9a-f-]{36}$/.test(id)) {
    return NextResponse.json({ error: 'Falta el id del prospecto.' }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const lectura = admin.from('prospecto')
    .select('id, empresa, ciudad, telefono, correo, contacto_nombre, vacante, estado, fuente, notas')
    .eq('id', id);
  const lecturaViva = typeof (lectura as { is?: unknown }).is === 'function'
    ? (lectura as typeof lectura & { is: (c: string, v: null) => typeof lectura }).is('duplicado_de', null)
    : lectura;
  const { data: p, error: errLeer } = await lecturaViva.single();
  if (errLeer || !p) return NextResponse.json({ error: 'Ese prospecto no existe.' }, { status: 404 });

  // Ganado/perdido es un desenlace, no otra oportunidad de gastar modelo.
  // Los aliases históricos reciben el mismo trato que los estados canónicos.
  const estado = normalizarEstadoProspecto(p.estado);
  if (estado === 'won' || estado === 'lost') {
    return NextResponse.json({
      error: 'Ese prospecto ya está cerrado; no se genera otro primer toque.',
      codigo: 'prospecto_terminal',
    }, { status: 409 });
  }

  const giro = giroDe(p.empresa, p.vacante, p.notas);
  // AUDITORÍA 18 (C2): a OpenRouter sale la EMPRESA, no la PERSONA. El nombre
  // del decisor se queda aquí (marcador en la ficha, repuesto al volver) y las
  // notas van sin correos, teléfonos ni el nombre. Ver seudonimo.ts.
  const notas = notasSinPersona(p.notas, p.contacto_nombre);
  const ficha = [
    `Empresa: ${p.empresa}`,
    `Giro: ${NOMBRE_GIRO[giro]}`,
    p.ciudad ? `Plaza: ${p.ciudad}` : null,
    lineaDecisor(p.contacto_nombre),
    p.vacante ? `Vacante publicada (el gancho, cítala): "${p.vacante}"` : 'Sin vacante conocida — el gancho es el giro y la plaza.',
    notas ? `Todo lo que sabemos (censo/fichas/DENUE):\n${notas.slice(0, 1500)}` : null,
  ].filter(Boolean).join('\n');

  try {
    const r = await generateStructured({
      role: 'marketing',
      system: SYSTEM,
      messages: [{ role: 'user', content: `Redacta el primer toque (mensaje_wa, correo_asunto, correo_cuerpo) para este prospecto:\n\n${ficha}` }],
      schema: Salida,
      schemaName: 'primer_toque',
      maxTokens: 900,
      temperature: 0.7,
      signal: AbortSignal.timeout(30_000),
      budget: createLlmBudget(sesion.tenantId, randomUUID(), 'interactivo'),
    });
    const ahora = new Date().toISOString();
    // El nombre vuelve aquí, sin haber salido; y cada toque cierra con la
    // liga del aviso de prospectos (art. 16 fr. II: el aviso simplificado se
    // pone a disposición en el primer contacto por medio electrónico).
    const pie = pieAvisoProspectos();
    const mensajeWa = `${reponerDecisor(r.data.mensaje_wa, p.contacto_nombre)}\n${pie}`;
    const correoAsunto = reponerDecisor(r.data.correo_asunto, p.contacto_nombre);
    const correoCuerpo = `${reponerDecisor(r.data.correo_cuerpo, p.contacto_nombre)}\n\n${pie}`;
    // AUDITORÍA 24, BE-29: el `update` vivía DENTRO de este mismo `try`, así
    // que un bache al guardar caía en el mismo `catch` que una falla del
    // modelo y contestaba 502 «El redactor no contestó». Dos mentiras en una:
    // el redactor SÍ contestó (y ya se pagó), y los tres textos —que estaban
    // en memoria— se tiraban a la basura en vez de viajar en la respuesta. El
    // vendedor volvía a apretar el botón y se pagaba el modelo otra vez.
    //
    // El guardado es su propio intento: falle o no, lo redactado se entrega.
    let guardado = true;
    const { error: errEscribir } = await admin
      .from('prospecto')
      .update({
        mensaje_wa: mensajeWa,
        mensaje_correo_asunto: correoAsunto,
        mensaje_correo: correoCuerpo,
        mensajes_generados_en: ahora,
        mensajes_modelo: r.model,
      })
      .eq('id', id);
    if (errEscribir) {
      guardado = false;
      logger.error('cerebro.mensaje_sin_guardar', { prospecto: id, err: errEscribir.message });
    }
    logger.info('cerebro.mensaje_generado', {
      prospecto: id, modelo: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut,
      costoUsd: r.cost, actor: sesion.userId, guardado,
    });
    return NextResponse.json({
      mensajeWaIa: mensajeWa,
      correoAsuntoIa: correoAsunto,
      correoCuerpoIa: correoCuerpo,
      mensajesGeneradosEn: ahora,
      // Un rótulo tiene que ser verdad: si no se guardó, la pantalla no puede
      // decir «guardado». Se dice, y los textos van igual — cópialos ahora,
      // porque al recargar la ficha no van a estar.
      guardado,
      ...(guardado ? {} : { aviso: 'Los textos se redactaron pero NO se pudieron guardar en la ficha: cópialos antes de salir, al recargar no van a estar.' }),
    });
  } catch (e) {
    logger.error('cerebro.mensaje_fallo', { prospecto: id, err: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ error: 'El redactor no contestó — el botón sigue con la plantilla.' }, { status: 502 });
  }
}
