// ═══════════════════════════════════════════════════════════════════════════
// POST /api/mcp — el servidor MCP de Likida (Streamable HTTP, sin estado).
//
// Es la puerta por la que Claude y ChatGPT le preguntan a los datos de UNA
// flota. El orden del gateo es el de /v1 (`_comun.ts`), calcado a propósito:
//
//   1. tasa por IP — antes de gastar un viaje a Supabase averiguando quién es;
//   2. credencial → flota (Bearer: llave de API u OAuth; AQUÍ NO HAY COOKIE);
//   3. tasa por flota — una credencial válida en bucle también se acota;
//   4. el ÁREA la exige el despachador POR HERRAMIENTA (`herramientas.ts`),
//      porque a diferencia de /v1 un mismo endpoint sirve herramientas de
//      operación y de dinero.
//
// El 401 lleva `WWW-Authenticate` con la liga al Protected Resource Metadata
// (RFC 9728): es como Claude y ChatGPT descubren DÓNDE autorizarse. Sin esa
// cabecera, el cliente ve un 401 mudo y no ofrece el botón de conectar.
//
// CADA CONSULTA QUEDA EN LA BITÁCORA: qué herramienta, con qué credencial y
// cuándo — y también los intentos negados por área. Un acceso a datos
// fiscales sin rastro no es auditable.
// ═══════════════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { rateLimit, clientIp } from '@/lib/ratelimit';
import { TASA_ANONIMA, TASA_POR_FLOTA, VENTANA_MS } from '@/app/api/v1/_comun';
import { resolverCredencialMcp, type CredencialMcp } from '@/lib/mcp/credencial';
import {
  RPC, leerPeticion, respuestaError, respuestaOk, resultadoInitialize, resultadoDiscover,
  versionDeclarada, VERSIONES_SOPORTADAS, TOOLS_LIST_TTL_MS,
  type RespuestaRpc,
} from '@/lib/mcp/protocolo';
import { describirHerramientas, despacharHerramienta } from '@/lib/mcp/herramientas';
import { anotarBitacora } from '@/lib/likida/bitacora_escritura';
import { registrarEventoSeguridad } from '@/lib/seguridad/eventos';
import { leerTextoAcotado } from '@/lib/http/cuerpo_acotado';
import { LecturaIncompleta } from '@/lib/likida/pg';
import { appUrl } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Literal, no constante importada: Next lo lee con análisis estático.
export const maxDuration = 60;

/** Un cuerpo JSON-RPC no tiene por qué pasar de esto: la petición más gorda
 *  legítima (tools/call con argumentos) cabe en unos cientos de bytes. */
const CUERPO_MAX_BYTES = 64 * 1024;

function sinAutorizacion(status: 401 | 503, motivo: string): NextResponse {
  const res = NextResponse.json({ error: motivo }, { status });
  if (status === 401) {
    // RFC 9728 §5.1: el recurso protegido apunta a su metadata para que el
    // cliente descubra el servidor de autorización.
    res.headers.set(
      'WWW-Authenticate',
      `Bearer resource_metadata="${appUrl()}/.well-known/oauth-protected-resource/api/mcp"`,
    );
  }
  return res;
}

function json(r: RespuestaRpc, status = 200): NextResponse {
  return NextResponse.json(r, { status });
}

async function atenderPeticion(cred: CredencialMcp, metodo: string, id: string | number, params: unknown): Promise<RespuestaRpc> {
  // Un cliente 2026-07-28 declara su versión en `_meta` de CADA petición.
  // Si declara una que no atendemos, el error dedicado se lo dice; si no
  // declara nada, es de la generación del handshake y se sigue normal.
  const declarada = versionDeclarada(params);
  if (declarada !== null && !(VERSIONES_SOPORTADAS as readonly string[]).includes(declarada)) {
    return respuestaError(
      id, RPC.UNSUPPORTED_PROTOCOL_VERSION,
      `Versión de protocolo no soportada: ${declarada}. Soportadas: ${VERSIONES_SOPORTADAS.join(', ')}.`,
    );
  }
  if (metodo === 'initialize') {
    const p = (params ?? {}) as Record<string, unknown>;
    return respuestaOk(id, resultadoInitialize(p.protocolVersion));
  }
  if (metodo === 'server/discover') {
    return respuestaOk(id, resultadoDiscover());
  }
  if (metodo === 'ping') {
    return respuestaOk(id, {});
  }
  if (metodo === 'tools/list') {
    // `ttlMs`/`cacheScope` son de la 2026-07-28; los clientes anteriores
    // ignoran campos que no conocen.
    return respuestaOk(id, { tools: describirHerramientas(), ttlMs: TOOLS_LIST_TTL_MS, cacheScope: 'private' });
  }
  if (metodo === 'tools/call') {
    const p = (params ?? {}) as Record<string, unknown>;
    const nombre = typeof p.name === 'string' ? p.name : '';
    const despacho = await despacharHerramienta(nombre, p.arguments, cred.tenantId, cred.alcanza);

    if (!despacho.ok && despacho.tipo === 'desconocida') {
      return respuestaError(id, RPC.INVALID_PARAMS, despacho.mensaje);
    }
    if (!despacho.ok && despacho.tipo === 'sin_permiso') {
      // El intento negado TAMBIÉN deja rastro: es la señal temprana de una
      // credencial acotada que alguien está empujando más allá de su área.
      await registrarEventoSeguridad({
        origen: 'otro', tipo: 'acceso_denegado', tenantId: cred.tenantId,
        actor: cred.via, detalle: { superficie: 'mcp', herramienta: nombre, area: despacho.area, rol: cred.rol },
      });
      await anotarBitacora(
        {
          tenantId: cred.tenantId, actor: cred.actor, accion: 'mcp.consulta_negada',
          entidad: 'tenant', entidadId: cred.tenantId,
          detalle: { herramienta: nombre, via: cred.via, area: despacho.area },
        },
        { evento: 'mcp.bitacora' },
      );
      return respuestaOk(id, { content: [{ type: 'text', text: despacho.mensaje }], isError: true });
    }
    if (!despacho.ok) {
      return respuestaOk(id, { content: [{ type: 'text', text: despacho.mensaje }], isError: true });
    }

    await anotarBitacora(
      {
        tenantId: cred.tenantId, actor: cred.actor, accion: 'mcp.consulta',
        entidad: 'tenant', entidadId: cred.tenantId,
        detalle: { herramienta: nombre, via: cred.via },
      },
      { evento: 'mcp.bitacora' },
    );

    return respuestaOk(id, {
      content: [{ type: 'text', text: despacho.resultado.texto }],
      ...(despacho.resultado.estructurado ? { structuredContent: despacho.resultado.estructurado } : {}),
      isError: false,
    });
  }
  return respuestaError(id, RPC.METHOD_NOT_FOUND, `Método desconocido: ${metodo}.`);
}

export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!(await rateLimit(`mcp:ip:${ip}`, TASA_ANONIMA, VENTANA_MS))) {
    return NextResponse.json({ error: `Máximo ${TASA_ANONIMA} peticiones por minuto sin identificar. Espera un momento.` }, { status: 429 });
  }

  let cred: CredencialMcp;
  try {
    const r = await resolverCredencialMcp(req.headers.get('authorization'));
    if (!r.ok) {
      if (r.status === 401) logger.warn('mcp.no_autenticado', { ip });
      return sinAutorizacion(r.status, r.motivo);
    }
    cred = r.credencial;
  } catch (e) {
    // Por debajo hay `supabaseAdmin()`: una env ausente o un SDK que truena
    // lanzan. Eso es un 503 nuestro, nunca un 401 que haga tirar el token.
    logger.error('mcp.credencial', { err: e instanceof Error ? e.message : String(e) });
    return sinAutorizacion(503, 'No se pudo verificar la credencial. Intenta de nuevo.');
  }

  if (!(await rateLimit(`mcp:flota:${cred.tenantId}`, TASA_POR_FLOTA, VENTANA_MS))) {
    return NextResponse.json({ error: `Máximo ${TASA_POR_FLOTA} peticiones por minuto por flota. Espera un momento.` }, { status: 429 });
  }

  const lecturaCuerpo = await leerTextoAcotado(req, CUERPO_MAX_BYTES);
  if (!lecturaCuerpo.ok && lecturaCuerpo.motivo === 'lectura_fallida') {
    return json(respuestaError(null, RPC.PARSE_ERROR, 'No se pudo leer el cuerpo.'), 400);
  }
  if (!lecturaCuerpo.ok) {
    await registrarEventoSeguridad({
      origen: 'otro', tipo: 'payload_excesivo', tenantId: cred.tenantId, actor: cred.via,
      detalle: { superficie: 'mcp', bytes: `>${CUERPO_MAX_BYTES}` },
    });
    return json(respuestaError(null, RPC.INVALID_REQUEST, 'El cuerpo excede el tamaño permitido.'), 400);
  }
  const crudo = lecturaCuerpo.texto;
  let cuerpo: unknown;
  try {
    cuerpo = JSON.parse(crudo);
  } catch {
    return json(respuestaError(null, RPC.PARSE_ERROR, 'El cuerpo no es JSON válido.'), 400);
  }

  const lectura = leerPeticion(cuerpo);
  if (!lectura.ok) return json(lectura.error, 400);

  // Una notificación (initialized, cancelled…) se acepta sin cuerpo: 202,
  // como manda Streamable HTTP.
  if (lectura.esNotificacion) {
    return new NextResponse(null, { status: 202 });
  }

  const { peticion } = lectura;
  const id = peticion.id as string | number;
  try {
    return json(await atenderPeticion(cred, peticion.method, id, peticion.params));
  } catch (e) {
    const mensaje = e instanceof Error ? e.message : String(e);
    logger.error('mcp.peticion', { metodo: peticion.method, tenant: cred.tenantId, err: mensaje });
    if (e instanceof LecturaIncompleta) {
      // El único error interno que se distingue: reintentar NO lo arregla y
      // el modelo debe saber que no hay cifra parcial que citar.
      return json(respuestaOk(id, {
        content: [{
          type: 'text',
          text: 'La flota tiene más filas de las que una lectura puede traer demostrando que están todas. No se devuelve una cifra parcial: acota el periodo o consulta el panel.',
        }],
        isError: true,
      }));
    }
    // El detalle interno NO cruza (mismo criterio que `fallo()` en /v1):
    // quedó en el log, y el modelo solo necesita saber que puede reintentar.
    return json(respuestaOk(id, {
      content: [{ type: 'text', text: 'No se pudo completar la consulta. El detalle quedó en los registros de Likida; vuelve a intentar en un momento.' }],
      isError: true,
    }));
  }
}

// Sin streams del servidor: este servidor contesta cada POST con JSON y no
// abre canales. El 405 con `Allow` es la respuesta que Streamable HTTP
// contempla para servidores que no ofrecen GET.
export function GET() {
  return new NextResponse(null, { status: 405, headers: { Allow: 'POST' } });
}

// Sin sesiones no hay nada que terminar.
export function DELETE() {
  return new NextResponse(null, { status: 405, headers: { Allow: 'POST' } });
}
