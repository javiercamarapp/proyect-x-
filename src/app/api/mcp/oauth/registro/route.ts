// ═══════════════════════════════════════════════════════════════════════════
// POST /api/mcp/oauth/registro — Dynamic Client Registration (RFC 7591).
//
// Claude y ChatGPT se registran solos ANTES de la primera autorización: nos
// mandan su nombre y sus redirect_uris y reciben un client_id. El registro es
// ABIERTO a propósito — así lo consumen ambos clientes— y eso NO regala nada:
// un cliente registrado no es una credencial, es un par (id, redirect_uris)
// que acota a dónde puede viajar un código. Sin sesión del panel y sin PKCE
// correcto, un client_id no compra nada.
//
// Lo que sí se acota es la TASA (10/min por IP): un registro es un insert, y
// un escáner en bucle no tiene por qué escribir mil filas por hora.
// ═══════════════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { rateLimit, clientIp } from '@/lib/ratelimit';
import { registrarCliente } from '@/lib/mcp/oauth';
import { leerTextoAcotado } from '@/lib/http/cuerpo_acotado';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TASA_REGISTRO = 10;
const VENTANA_MS = 60_000;

export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!(await rateLimit(`mcp:oauth:registro:${ip}`, TASA_REGISTRO, VENTANA_MS))) {
    return NextResponse.json(
      { error: 'invalid_client_metadata', error_description: `Máximo ${TASA_REGISTRO} registros por minuto.` },
      { status: 429 },
    );
  }

  let cuerpo: Record<string, unknown>;
  try {
    const lectura = await leerTextoAcotado(req, 16 * 1024);
    if (!lectura.ok) {
      return NextResponse.json({ error: 'invalid_client_metadata', error_description: 'La metadata excede el tamaño permitido.' }, { status: 400 });
    }
    cuerpo = JSON.parse(lectura.texto) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid_client_metadata', error_description: 'El cuerpo tiene que ser JSON.' }, { status: 400 });
  }

  const r = await registrarCliente(cuerpo.client_name, cuerpo.redirect_uris);
  if (!r.ok) {
    if (r.error === 'no_disponible') {
      return NextResponse.json({ error: 'invalid_client_metadata', error_description: r.detalle }, { status: 503 });
    }
    return NextResponse.json({ error: 'invalid_redirect_uri', error_description: r.detalle }, { status: 400 });
  }

  // RFC 7591 §3.2.1: se devuelve la metadata registrada tal cual quedó.
  return NextResponse.json(
    {
      client_id: r.cliente.clientId,
      ...(r.cliente.nombre ? { client_name: r.cliente.nombre } : {}),
      redirect_uris: r.cliente.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    { status: 201 },
  );
}
