import { NextResponse } from 'next/server';
import { rateLimit, clientIp } from '@/lib/ratelimit';
import { leerTextoAcotado } from '@/lib/http/cuerpo_acotado';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ═══════════════════════════════════════════════════════════════════════════
// EL DESTINO de `reportarAlServidor` (logger.ts) — el único puente entre un
// fallo SOLO-DE-CLIENTE (el layout raíz truena después de hidratar) y
// CUALQUIER rastro fuera del navegador del contralor (auditoría 25, ALTO
// REINCIDENTE — ver la cabecera de `reportarAlServidor` en logger.ts).
//
// SIN AUTH A PROPÓSITO, mismo criterio que /api/health: un error boundary de
// cliente corre ANTES o DESPUÉS de que la sesión se pueda leer (el layout
// raíz que truena puede ser el que iba a resolverla), así que este endpoint
// no puede depender de sesión. No devuelve nada de negocio — solo confirma
// que se registró — y todo lo que entra pasa por el MISMO redactor de PII
// que el resto del logger antes de tocar un log o Sentry.
//
// `msg` y `meta` son texto de un cliente que ya falló: nunca se confía en su
// forma. `msg` se sanea a una cadena corta sin saltos de línea (evita que un
// nombre de evento arbitrario contamine el nombre del evento de log/Sentry);
// `meta` se acepta solo si es un objeto plano, o se descarta.
// ═══════════════════════════════════════════════════════════════════════════

const MAX_BODY = 4 * 1024;
const NIVELES = new Set(['warn', 'error']);

function sanear(valor: unknown, maxLargo: number): string {
  if (typeof valor !== 'string') return '';
  return valor.replace(/[\r\n\t]+/g, ' ').trim().slice(0, maxLargo);
}

export async function POST(req: Request) {
  // Best-effort para el que llama (el cliente ya está en medio de un fallo),
  // pero SÍ acotado: sin techo, un cliente en bucle de render-error podría
  // martillar este endpoint sin límite.
  if (!(await rateLimit(`client-error:${clientIp(req)}`, 20, 60_000))) {
    return NextResponse.json({ ok: false }, { status: 429 });
  }
  const lectura = await leerTextoAcotado(req, MAX_BODY);
  if (!lectura.ok) {
    return NextResponse.json({ ok: false }, { status: lectura.motivo === 'demasiado_grande' ? 413 : 400 });
  }

  let cuerpo: unknown;
  try {
    const crudo = lectura.texto;
    cuerpo = crudo ? JSON.parse(crudo) : {};
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const { level, msg, meta } = (cuerpo && typeof cuerpo === 'object' ? cuerpo : {}) as {
    level?: unknown; msg?: unknown; meta?: unknown;
  };
  const nivel = NIVELES.has(level as string) ? (level as 'warn' | 'error') : 'error';
  const evento = `client.${sanear(msg, 80) || 'sin_evento'}`;
  const detalle = meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : {};

  // `logger[nivel]` ya redacta y ya replica a Sentry si SENTRY_DSN está
  // puesto — el mismo camino que un fallo de servidor. `origen: 'cliente'`
  // distingue esta línea de una equivalente que sí vino del servidor.
  logger[nivel](evento, { ...detalle, origen: 'cliente', ip: clientIp(req) });

  return NextResponse.json({ ok: true });
}
