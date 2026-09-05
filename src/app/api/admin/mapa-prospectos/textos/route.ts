import { leerTextoAcotado } from '@/lib/http/cuerpo_acotado';
// LOS TEXTOS LARGOS, A PEDIDO (FE-16).
//
// El listado del Cerebro dejó de cargar `notas` y los mensajes redactados por
// el agente experto: 15.3 MB de texto que solo se pintan en la ficha, en la
// tarjeta abierta y en el popup de calles — decenas de prospectos a la vez, no
// treinta y tres mil. Esta ruta los entrega por id.
//
// POST y no GET con `?ids=`: una tanda de mil UUIDs son 37 KB de URL y el
// proxy la rebota mucho antes (el mismo techo que documenta `traerPorIds` en
// pg.ts). Va en el cuerpo. Solo lectura; puerta propia, como el resto de la
// familia — detrás hay la cartera comercial con sus teléfonos y decisores.
import { NextResponse } from 'next/server';
import { getTextosProspectos } from '@/lib/admin/prospectos-mapa';
import { logger } from '@/lib/logger';
import { sesionSuperadmin } from '../puerta';
import { vieneDeNuestroSitio } from '@/lib/auth/csrf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Cuántos ids se aceptan en UNA petición. El cliente parte en tandas de este
 *  tamaño (la exportación del CSV puede pedir el universo entero); el
 *  servidor las vuelve a partir de 200 en 200 contra PostgREST.
 *  Sin `export`: un `route.ts` solo puede exportar los verbos y la config de
 *  Next — cualquier otra exportación tumba el type-check del build. */
const TOPE_IDS = 2_000;

const ES_UUID = /^[0-9a-f-]{36}$/;

export async function POST(req: Request) {
  // Auditoría 21, BAJO-MEDIO: el chequeo CSRF explícito (SEG-9) solo cubría
  // /api/admin/palette y /v1/*. Es POST y no GET por tamaño de payload, pero
  // sigue siendo cookie-autenticada — misma puerta que el resto de la
  // familia, aunque esta ruta en particular sea de solo lectura.
  if (!vieneDeNuestroSitio(req)) {
    logger.warn('mapa_prospectos.textos_origen_ajeno', { origen: req.headers.get('origin'), sitio: req.headers.get('sec-fetch-site') });
    return NextResponse.json({ error: 'Petición de otro sitio.' }, { status: 403 });
  }

  const { error } = await sesionSuperadmin();
  if (error) return error;
  // 2,000 UUIDs incluso escapados en JSON (~432 KB), más envoltura.
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
  if (!Array.isArray(cuerpo?.ids)) {
    return NextResponse.json({ error: 'Falta la lista de ids.' }, { status: 400 });
  }
  // Se filtra lo que no es un uuid en vez de rechazar la tanda entera: un id
  // basura no debe apagar los otros mil novecientos noventa y nueve.
  const ids = [...new Set(cuerpo.ids.filter((x): x is string => typeof x === 'string' && ES_UUID.test(x)))];
  if (ids.length > TOPE_IDS) {
    return NextResponse.json({ error: `Máximo ${TOPE_IDS} ids por petición.` }, { status: 400 });
  }
  try {
    const textos = await getTextosProspectos(ids);
    return NextResponse.json({ textos }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    logger.error('mapa_prospectos.textos', { err: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ error: 'No se pudieron leer los textos.' }, { status: 500 });
  }
}
