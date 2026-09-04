// ═══════════════════════════════════════════════════════════════════════════
// POST /api/mcp/oauth/token — el canje (RFC 6749 §4.1.3) y el refresco.
//
// Dos grant types y ninguno más:
//   · authorization_code + PKCE S256 → par acceso/refresco;
//   · refresh_token → rotación (el viejo muere, y su REUSO tumba la familia).
//
// Los errores usan el vocabulario del RFC (§5.2) porque quien ramifica sobre
// ellos es la librería OAuth de Claude/ChatGPT, no una persona:
// `invalid_grant` para todo lo que no vale (sin distinguir cuál mitad falló,
// mismo criterio que `resolverLlave`), `invalid_request` para forma,
// `unsupported_grant_type` para lo que no hay. Una base que no contesta es
// 503 — jamás `invalid_grant`, que haría al cliente tirar un refresco bueno.
// ═══════════════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { rateLimit, clientIp } from '@/lib/ratelimit';
import { canjearCodigo, refrescarTokens, type ResultadoCanje } from '@/lib/mcp/oauth';
import { leerTextoAcotado } from '@/lib/http/cuerpo_acotado';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TASA_TOKEN = 30;
const VENTANA_MS = 60_000;

function errorOauth(error: string, descripcion: string, status = 400): NextResponse {
  return NextResponse.json({ error, error_description: descripcion }, { status });
}

function contestarCanje(r: ResultadoCanje): NextResponse {
  if (!r.ok) {
    if (r.error === 'no_disponible') return errorOauth('server_error', r.detalle, 503);
    return errorOauth('invalid_grant', r.detalle);
  }
  return NextResponse.json(
    {
      access_token: r.tokens.acceso,
      token_type: 'Bearer',
      expires_in: r.tokens.expiraEnSegundos,
      refresh_token: r.tokens.refresco,
      scope: r.tokens.scope,
    },
    // RFC 6749 §5.1: las respuestas con token no se cachean.
    { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
  );
}

export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!(await rateLimit(`mcp:oauth:token:${ip}`, TASA_TOKEN, VENTANA_MS))) {
    return errorOauth('invalid_request', `Máximo ${TASA_TOKEN} canjes por minuto.`, 429);
  }

  let form: URLSearchParams;
  try {
    const lectura = await leerTextoAcotado(req, 8 * 1024);
    if (!lectura.ok) return errorOauth('invalid_request', 'El cuerpo excede el tamaño permitido.');
    form = new URLSearchParams(lectura.texto);
  } catch {
    return errorOauth('invalid_request', 'El cuerpo tiene que ser application/x-www-form-urlencoded.');
  }

  const grant = form.get('grant_type');
  const clientId = form.get('client_id');
  if (!clientId) return errorOauth('invalid_client', 'Falta client_id.', 401);

  if (grant === 'authorization_code') {
    const codigo = form.get('code');
    const redirectUri = form.get('redirect_uri');
    const verifier = form.get('code_verifier');
    if (!codigo || !redirectUri || !verifier) {
      return errorOauth('invalid_request', 'Faltan code, redirect_uri o code_verifier.');
    }
    return contestarCanje(await canjearCodigo(codigo, clientId, redirectUri, verifier));
  }

  if (grant === 'refresh_token') {
    const refresco = form.get('refresh_token');
    if (!refresco) return errorOauth('invalid_request', 'Falta refresh_token.');
    return contestarCanje(await refrescarTokens(refresco, clientId));
  }

  return errorOauth('unsupported_grant_type', 'Solo authorization_code y refresh_token.');
}
