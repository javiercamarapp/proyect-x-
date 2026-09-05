import { NextResponse } from 'next/server';
import { cuadrarViaje, type PoliticaGasto } from '@/lib/likida/cuadre/engine';
import { rateLimit, clientIp } from '@/lib/ratelimit';
import { leerTextoAcotado } from '@/lib/http/cuerpo_acotado';
import type { Gasto } from '@/types/likida';

// SEG-8 / OP-P10 (auditoría 24): este GET público contestaba `envHealth()` —
// `{llm, whatsapp, supabase}` — o sea, un mapa de qué integraciones están
// configuradas para cualquiera que lo pidiera. El demo no lo necesita (el
// POST no depende de ninguna) y /admin/salud-sistema ya lo enseña con sesión.
export async function GET() {
  return NextResponse.json({ ok: true });
}

export const runtime = 'nodejs';

// Demo determinístico (sin LLM ni DB) — corre el MOTOR DE CUADRE real sobre
// comprobantes de ejemplo. Robusto para una demo en vivo: nunca depende de red.

// 🔴 INVENTADO: política de fantasía para el demo (misma que seed.sql).
// Ajústala con la política real de la flota.
const POLITICA: PoliticaGasto[] = [
  { concepto: 'diesel', topeMonto: 4000 },
  { concepto: 'caseta', topeMonto: 1500 },
  { concepto: 'alimentacion', topeMonto: 800 },
  { concepto: 'hospedaje', topeMonto: 2500 },
  { concepto: 'transporte', topeMonto: 800 },
  { concepto: 'flete' },
  { concepto: 'factura', requiereCfdi: true },
];

/** Tope real en bytes, aplicado durante la lectura del stream. */
const MAX_BODY = 64 * 1024;

export async function POST(req: Request) {
  // El lector corta por bytes aunque no exista Content-Length: este endpoint
  // es público y no puede materializar un body chunked ilimitado.
  if (!(await rateLimit(`demo:${clientIp(req)}`, 30, 60_000))) return NextResponse.json({ error: 'demasiadas peticiones' }, { status: 429 });

  const lectura = await leerTextoAcotado(req, MAX_BODY);
  if (!lectura.ok) {
    return NextResponse.json(
      { error: lectura.motivo === 'demasiado_grande' ? 'payload muy grande' : 'no se pudo leer el cuerpo' },
      { status: lectura.motivo === 'demasiado_grande' ? 413 : 400 },
    );
  }
  const crudo = lectura.texto;
  let body: { comprobantes: Partial<Gasto>[]; anticipo: number };
  try {
    body = JSON.parse(crudo) as { comprobantes: Partial<Gasto>[]; anticipo: number };
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const gastos: Gasto[] = (body.comprobantes ?? []).map((c, i) => ({
    id: `g${i}`,
    concepto: c.concepto ?? 'otro',
    monto: c.monto ?? 0,
    folio: c.folio,
    cfdiUuid: c.cfdiUuid,
    // Sin esto (ensayo 14-ago-2026), el receptor del CFDI se TIRABA en el
    // mapeo y el preset de factura del simulador salía «receptor no
    // verificable» — una observación que el guion no espera y que en la sala
    // parecería un defecto. El motor tenía razón; el cable no.
    rfcReceptor: c.rfcReceptor,
    ocrConfianza: c.ocrConfianza ?? 0.96,
  }));
  // El RFC de la flota demo (el del seed): con él, la validación de receptor
  // CORRE en el simulador — que es justo lo que el guion narra en §5. Sin
  // empresaRfc, la comprobación entera se salta en silencio y el demo
  // enseñaría el motor con esa defensa apagada.
  const liq = cuadrarViaje({ viajeId: 'demo', anticipo: body.anticipo ?? 0, gastos, politica: POLITICA, ruta: 'Silao-Laredo', empresaRfc: 'GMX0902279I1' });
  return NextResponse.json({
    totalComprobado: liq.totalComprobado,
    totalAnticipo: liq.totalAnticipo,
    diferencia: liq.diferencia,
    estatus: liq.estatus,
    diferencias: liq.diferencias.map((d) => ({ tipo: d.tipo, nota: d.nota, monto: d.monto })),
  });
}
