// ═══════════════════════════════════════════════════════════════════════════
// /mcp/autorizar — la pantalla de consentimiento OAuth del servidor MCP.
//
// Aquí es donde la identidad del panel se convierte en un acceso para Claude
// o ChatGPT. El flujo es el del RFC 6749 §4.1 con las reglas de OAuth 2.1:
//
//   · SIN sesión del panel no hay pantalla: se rebota a /login y se vuelve.
//   · Un client_id desconocido o una redirect_uri NO registrada se contestan
//     con una PÁGINA de error, jamás con un redirect (§4.1.2.1: redirigir a
//     una URI no verificada es regalar el open redirect).
//   · Todo lo demás que falte (challenge, response_type…) SÍ se redirige con
//     su código de error, porque la redirect_uri ya está verificada.
//   · El botón «Autorizar» es un server action que RE-VALIDA todo contra la
//     base — los hidden inputs son mensajería, no autoridad— y emite el
//     código atado a (tenant, usuario, rol) de LA SESIÓN, no de ningún input.
//
// SUPERADMIN NO CONSIENTE AQUÍ a propósito: su tenant es ambiguo por diseño
// (elige flota por cookie), y un token MCP que cruzara flotas violaría la
// regla número uno del servidor. Para el panel de Javier están las llaves de
// API por flota.
// ═══════════════════════════════════════════════════════════════════════════

import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getSessionTenant, SIN_ROL } from '@/lib/auth/session';
import { areasDe } from '@/lib/auth/visibilidad';
import { leerCliente, emitirCodigo, redirectUriRegistrada, recursoCanonico, SCOPE_LECTURA } from '@/lib/mcp/oauth';
import { appUrl } from '@/lib/env';
import { anotarBitacora } from '@/lib/likida/bitacora_escritura';
import { Logo } from '../../logo';

export const dynamic = 'force-dynamic';

interface ParamsAutorizar {
  client_id: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  resource: string | null;
}

function uno(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/** Arma la URL de vuelta al cliente preservando su query original. */
function volverA(redirectUri: string, extras: Record<string, string | null>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(extras)) {
    if (v !== null) u.searchParams.set(k, v);
  }
  return u.toString();
}

function Marco({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <main
      className="min-h-screen flex flex-col justify-between px-8 py-8 md:px-14 md:py-12"
      style={{ background: 'var(--bg)' }}
    >
      <Logo alto="h-6" className="self-start" />
      <div className="max-w-2xl">
        <p className="text-xs font-medium uppercase" style={{ color: 'var(--muted)', letterSpacing: '0.14em' }}>
          Conectar con Likida
        </p>
        <h1
          className="mt-5 font-medium"
          style={{
            fontFamily: 'var(--font-display), system-ui, sans-serif',
            fontSize: 'clamp(30px, 5vw, 56px)',
            lineHeight: 1.02,
            letterSpacing: '-0.035em',
            textWrap: 'balance',
          }}
        >
          {titulo}
        </h1>
        {children}
      </div>
      <p className="text-xs" style={{ color: 'var(--faint, var(--muted))' }}>
        Likida · Liquidación de viajes por WhatsApp
      </p>
    </main>
  );
}

function PaginaError({ titulo, detalle }: { titulo: string; detalle: string }) {
  return (
    <Marco titulo={titulo}>
      <p className="mt-6 max-w-lg" style={{ color: 'var(--muted)', fontSize: 17, lineHeight: 1.55 }}>
        {detalle}
      </p>
    </Marco>
  );
}

const ROTULO_AREA: Record<string, string> = {
  operacion: 'la operación (viajes, unidades y sus papeles)',
  dinero: 'el dinero (cuadres, facturación, estado fiscal y métricas)',
  administracion: 'la administración de la cuenta',
};

export default async function Autorizar({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const clientId = uno(sp.client_id);
  const redirectUri = uno(sp.redirect_uri);
  const state = uno(sp.state);
  const responseType = uno(sp.response_type);
  const codeChallenge = uno(sp.code_challenge);
  const challengeMethod = uno(sp.code_challenge_method);
  const resource = uno(sp.resource);

  // ── 1. El cliente y su redirect, ANTES que nada (sin redirect de error) ──
  if (!clientId || !redirectUri) {
    return <PaginaError titulo="Falta con quién conectar" detalle="A esta pantalla se llega desde Claude o ChatGPT al conectar Likida, no directamente. Falta client_id o redirect_uri." />;
  }
  const rc = await leerCliente(clientId);
  if (!rc.ok) {
    return rc.error === 'no_disponible'
      ? <PaginaError titulo="No se pudo verificar el cliente" detalle="Hubo un problema temporal leyendo el registro. Cierra esta pestaña e intenta conectar de nuevo." />
      : <PaginaError titulo="Cliente desconocido" detalle="El cliente que pide acceso no está registrado. Vuelve a intentar la conexión desde tu aplicación." />;
  }
  if (!redirectUriRegistrada(redirectUri, rc.cliente.redirectUris)) {
    return <PaginaError titulo="Dirección de retorno no registrada" detalle="La dirección a la que habría que devolver la autorización no coincide con la que este cliente registró. Por seguridad no se redirige a direcciones no verificadas." />;
  }

  // ── 2. La forma de la petición (la redirect ya está verificada) ──────────
  if (responseType !== 'code') {
    redirect(volverA(redirectUri, { error: 'unsupported_response_type', state }));
  }
  if (!codeChallenge || challengeMethod !== 'S256' || codeChallenge.length < 43 || codeChallenge.length > 128) {
    redirect(volverA(redirectUri, { error: 'invalid_request', error_description: 'PKCE S256 es obligatorio.', state }));
  }
  if (resource !== null && resource !== recursoCanonico()) {
    redirect(volverA(redirectUri, { error: 'invalid_target', state }));
  }

  // ── 3. La identidad: la sesión del panel, y nada más ─────────────────────
  const s = await getSessionTenant();
  if (!s) {
    const propia = new URL(`${'/mcp/autorizar'}`, 'https://x.invalid');
    for (const [k, v] of Object.entries(sp)) {
      const val = uno(v);
      if (val !== null) propia.searchParams.set(k, val);
    }
    redirect(`/login?next=${encodeURIComponent(`/mcp/autorizar${propia.search}`)}`);
  }
  if (s.rol === 'superadmin') {
    return <PaginaError titulo="El superadmin no conecta por aquí" detalle="Un acceso MCP queda atado a UNA flota, y tu cuenta cruza todas. Para conectar una flota concreta usa una llave de API emitida desde su panel (Dashboard → Llaves de API)." />;
  }
  if (!s.tenantId || s.rol === SIN_ROL || areasDe(s.rol).length === 0) {
    return <PaginaError titulo="Tu cuenta aún no tiene flota" detalle="Iniciaste sesión, pero esta cuenta no está vinculada a ninguna flota con un rol activo. Pídele a tu administrador que te dé de alta y vuelve a conectar." />;
  }

  const areas = areasDe(s.rol);
  const nombreCliente = rc.cliente.nombre ?? 'Un cliente MCP';
  const params: ParamsAutorizar = { client_id: clientId, redirect_uri: redirectUri, state, code_challenge: codeChallenge, resource };

  // ── El server action: re-valida TODO y emite el código ───────────────────
  async function autorizar(formData: FormData) {
    'use server';
    const decision = String(formData.get('decision') ?? '');
    const p: ParamsAutorizar = {
      client_id: String(formData.get('client_id') ?? ''),
      redirect_uri: String(formData.get('redirect_uri') ?? ''),
      state: (formData.get('state') as string | null) || null,
      code_challenge: String(formData.get('code_challenge') ?? ''),
      resource: (formData.get('resource') as string | null) || null,
    };

    // La identidad SIEMPRE se relee de la sesión en el momento de firmar.
    const sesion = await getSessionTenant();
    if (!sesion || !sesion.tenantId || sesion.rol === SIN_ROL || sesion.rol === 'superadmin' || areasDe(sesion.rol).length === 0) {
      redirect('/login');
    }

    const cliente = await leerCliente(p.client_id);
    if (!cliente.ok || !redirectUriRegistrada(p.redirect_uri, cliente.cliente.redirectUris)) {
      redirect('/mcp/autorizar');
    }
    if (decision !== 'autorizar') {
      redirect(volverA(p.redirect_uri, { error: 'access_denied', state: p.state }));
    }
    if (p.code_challenge.length < 43 || p.code_challenge.length > 128) {
      redirect(volverA(p.redirect_uri, { error: 'invalid_request', state: p.state }));
    }
    if (p.resource !== null && p.resource !== recursoCanonico()) {
      redirect(volverA(p.redirect_uri, { error: 'invalid_target', state: p.state }));
    }

    const codigo = await emitirCodigo({
      clientId: p.client_id,
      userId: sesion.userId,
      // La sesión del panel no trae el correo y el token no lo necesita para
      // autorizar: la bitácora firma con `actor_id`, que sí viaja.
      userEmail: null,
      tenantId: sesion.tenantId,
      rol: sesion.rol,
      redirectUri: p.redirect_uri,
      codeChallenge: p.code_challenge,
      resource: p.resource,
    });
    if (!codigo.ok) {
      redirect(volverA(p.redirect_uri, { error: 'server_error', state: p.state }));
    }

    // El consentimiento es un acto: queda en la bitácora con quién y cuándo.
    await anotarBitacora(
      {
        tenantId: sesion.tenantId,
        actor: { id: sesion.userId },
        accion: 'mcp.consentimiento',
        entidad: 'tenant',
        entidadId: sesion.tenantId,
        detalle: { cliente: cliente.cliente.nombre ?? p.client_id, rol: sesion.rol },
      },
      { evento: 'mcp.bitacora' },
    );

    // `iss` (RFC 9207): el cliente MCP 2026-07-28 valida que quien contesta
    // sea el issuer que descubrió — cierra el mix-up de servidores.
    redirect(volverA(p.redirect_uri, { code: codigo.codigo, state: p.state, iss: appUrl() }));
  }

  return (
    <Marco titulo={`¿Dejar que ${nombreCliente} lea los datos de tu flota?`}>
      <p className="mt-6 max-w-lg" style={{ color: 'var(--muted)', fontSize: 17, lineHeight: 1.55 }}>
        Estás conectado como <strong>{s.nombre ?? 'usuario del panel'}</strong> ({s.rol.replace('_', ' ')}).
        Si autorizas, este cliente podrá <strong>leer</strong> — nunca cambiar — lo que tu rol ya ve en el panel:
      </p>
      <ul className="mt-4 max-w-lg list-disc pl-5" style={{ color: 'var(--muted)', fontSize: 16, lineHeight: 1.6 }}>
        {areas.map((a) => (
          <li key={a}>{ROTULO_AREA[a] ?? a}</li>
        ))}
      </ul>
      <p className="mt-4 max-w-lg text-sm" style={{ color: 'var(--faint, var(--muted))', lineHeight: 1.5 }}>
        El nombre «{nombreCliente}» lo declaró quien se registró, no Likida. El acceso expira solo y las
        acciones con efecto (cerrar liquidaciones, timbrar, enviar mensajes) seguirán firmándose en el panel.
        Alcance: {SCOPE_LECTURA}.
      </p>
      <form action={autorizar} className="mt-8 flex gap-3">
        <input type="hidden" name="client_id" value={params.client_id} />
        <input type="hidden" name="redirect_uri" value={params.redirect_uri} />
        {params.state !== null ? <input type="hidden" name="state" value={params.state} /> : null}
        <input type="hidden" name="code_challenge" value={params.code_challenge} />
        {params.resource !== null ? <input type="hidden" name="resource" value={params.resource} /> : null}
        <button
          type="submit" name="decision" value="autorizar"
          className="rounded-full px-6 py-2.5 text-sm font-medium"
          // AUDITORÍA 26, FE-4 (ALTO): apuntaba a un token «--fg» que no
          // existe en ninguna hoja del repo — la tinta de esta paleta es
          // `--ink`. Sin fallback, `var()` deja la declaración inválida y el
          // botón se quedaba con el fondo de la página y el texto del color de
          // la página: 1.00:1 en claro y en oscuro.
          style={{ background: 'var(--ink)', color: 'var(--bg)' }}
        >
          Autorizar lectura
        </button>
        <button
          type="submit" name="decision" value="denegar"
          className="rounded-full px-6 py-2.5 text-sm font-medium"
          style={{ border: '1px solid var(--muted)', color: 'var(--muted)' }}
        >
          No autorizar
        </button>
      </form>
    </Marco>
  );
}
