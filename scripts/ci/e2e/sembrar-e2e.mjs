#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SIEMBRA E2E — lo que `supabase/seed.sql` NO puede sembrar.
 *
 * El seed de SQL deja la flota demo con sus viajes y gastos, pero dos piezas
 * solo se pueden crear a través de los servicios de Supabase, no con un
 * INSERT:
 *
 *   1. Los usuarios de Auth. `app_user.id` tiene que ser el id de
 *      `auth.users` (el mismo contrato que `provisionar.ts`), y `auth.users`
 *      lo administra GoTrue — el seed de SQL lo dice explícitamente («NO se
 *      siembran app_user aquí A PROPÓSITO»). Aquí se crean por la admin API,
 *      exactamente como lo hace `provisionarUsuario()` en producción.
 *   2. El PDF de una liquidación. `pdf_url` guarda una ruta del bucket
 *      privado `liquidaciones`; sin un objeto real detrás, la ruta
 *      `/api/export/pdf/[id]` firma una URL hacia la nada. Se sube un PDF a
 *      la ruta canónica `{tenantId}/{viajeId}.pdf` (la misma que arma
 *      tools.ts) para la liquidación cuadrada del seed (VJ-2026-0844).
 *      El CONTENIDO del PDF aquí es sembrado, no generado por el motor — la
 *      generación real la cubren `pdf.test.ts`/`pdf_cifras.test.ts`; lo que
 *      la prueba de navegador afirma con esto es la PUERTA (sesión, rol,
 *      tenant, URL firmada de vida corta), que es lo que solo existe con la
 *      pila completa.
 *   3. `tenant.perfil` (declaración fiscal del estímulo de peaje, FISCAL
 *      19C2). `seed.sql` nunca lo toca, así que sin este paso
 *      `onboardingFiscalListo()` (dashboard/page.tsx) es SIEMPRE falso y
 *      CADA visita a `/dashboard` de la dueña rebota a `/dashboard/onboarding`
 *      — hallazgo real de E.27: tres pruebas (tableros, las dos de móvil)
 *      esperaban el Resumen y se toparon con el cuestionario. La cifra es
 *      🔴 INVENTADA, igual que el resto del seed — solo tiene que calificar
 *      (`ingresosAnualesMxn < 300M`, `parteRelacionada: false`).
 *
 * IDENTIDADES SEMBRADAS (correos @likida.test — TLD reservado, jamás
 * entregable; ninguna credencial real):
 *   · superadmin.e2e@likida.test → superadmin, sin tenant
 *   · duena.e2e@likida.test      → flota_admin de Flota Demo (11111111-…)
 *   · intrusa.e2e@likida.test    → flota_admin de Flota E2E B (22222222-…),
 *     la flota B existe SOLO para probar aislamiento: que sus credenciales
 *     no alcancen ni /admin ni los datos de la flota A.
 *   · encargado.e2e y contador.e2e → roles de oficina de Flota Demo.
 *   · vendedor.e2e → vendedor sin tenant, con cartera sintética propia y ajena.
 *
 * GUARD (mismo criterio que scripts/seed.sh): esto corre ÚNICAMENTE contra
 * un Supabase local. Cualquier host que no sea 127.0.0.1/localhost rehúsa,
 * sin bandera para forzarlo — a diferencia del seed del demo, NADA de este
 * archivo tiene un uso legítimo contra una base gestionada.
 *
 * Idempotente a propósito: en CI la pila nace virgen, pero en local se corre
 * después de cada `supabase db reset` y también sobre una pila ya sembrada.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { createClient } from '@supabase/supabase-js';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { exigirUrlLocal, fetchLocalE2E } from './entorno-local.mjs';

const url = exigirUrlLocal(process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321', 'SUPABASE_URL');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!serviceKey) {
  console.error('Falta SUPABASE_SERVICE_ROLE_KEY (la imprime `supabase status`).');
  process.exit(1);
}

const TENANT_A = '11111111-1111-1111-1111-111111111111'; // Flota Demo (seed.sql)
const TENANT_B = '22222222-eeee-4eee-8eee-222222222222'; // solo para aislamiento
const VIAJE_LIQUIDADO = '44444444-0000-0000-0000-000000000002'; // VJ-2026-0844, cuadrada

const USUARIOS = [
  { email: 'superadmin.e2e@likida.test', nombre: 'Superadmin E2E', rol: 'superadmin', tenant: null },
  { email: 'duena.e2e@likida.test', nombre: 'Dueña E2E', rol: 'flota_admin', tenant: TENANT_A },
  { email: 'encargado.e2e@likida.test', nombre: 'Encargado E2E', rol: 'encargado', tenant: TENANT_A },
  { email: 'contador.e2e@likida.test', nombre: 'Contador E2E', rol: 'contador', tenant: TENANT_A },
  { email: 'vendedor.e2e@likida.test', nombre: 'Vendedor E2E', rol: 'vendedor', tenant: null },
  { email: 'intrusa.e2e@likida.test', nombre: 'Intrusa E2E', rol: 'flota_admin', tenant: TENANT_B },
];

const admin = createClient(url, serviceKey, { auth: { persistSession: false }, global: { fetch: fetchLocalE2E } });

/** supabase-js reporta errores POR VALOR: aquí todo fallo detiene la siembra
 *  con su mensaje — una siembra a medias produce pruebas que mienten. */
function exigir(error, paso) {
  if (error) {
    console.error(`sembrar-e2e: falló «${paso}»: ${error.message ?? error}`);
    process.exit(1);
  }
}

// ── 1. La flota B, el otro lado de la pared de aislamiento ─────────────────
{
  const { error } = await admin.from('tenant').upsert(
    { id: TENANT_B, nombre: 'Flota E2E B', rfc: null, ciudad: 'Querétaro', plan: 'demo' },
    { onConflict: 'id' },
  );
  exigir(error, 'upsert tenant B');
}

// ── 2. Usuarios de Auth + su fila de app_user (contrato de provisionar.ts) ──
let duenaUserId = null;
let vendedorUserId = null;
for (const u of USUARIOS) {
  let userId = null;
  const creado = await admin.auth.admin.createUser({ email: u.email, email_confirm: true });
  if (creado.error) {
    // Ya existía (re-siembra local): buscarlo en vez de fallar. Cualquier
    // otro error sí detiene — un usuario a medias es una prueba que miente.
    const lista = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    exigir(lista.error, `listUsers tras createUser(${u.email})`);
    userId = lista.data.users.find((x) => x.email === u.email)?.id ?? null;
    if (!userId) exigir(creado.error, `createUser(${u.email})`);
  } else {
    userId = creado.data.user.id;
  }

  const { error } = await admin.from('app_user').upsert(
    { id: userId, tenant_id: u.tenant, email: u.email, nombre: u.nombre, rol: u.rol },
    { onConflict: 'id' },
  );
  exigir(error, `upsert app_user(${u.email})`);

  if (u.email === 'duena.e2e@likida.test') duenaUserId = userId;
  if (u.email === 'vendedor.e2e@likida.test') vendedorUserId = userId;
}

// ── 3. El PDF de VJ-2026-0844, en la ruta canónica del bucket privado ──────
{
  const doc = await PDFDocument.create();
  const pagina = doc.addPage([612, 792]);
  const fuente = await doc.embedFont(StandardFonts.Helvetica);
  pagina.drawText('Liquidacion VJ-2026-0844 - ejemplar sembrado para pruebas E2E', {
    x: 48, y: 720, size: 12, font: fuente,
  });
  pagina.drawText('Este PDF no sale del Supabase local. No es un documento fiscal.', {
    x: 48, y: 700, size: 10, font: fuente,
  });
  const bytes = await doc.save();

  const ruta = `${TENANT_A}/${VIAJE_LIQUIDADO}.pdf`;
  const subida = await admin.storage
    .from('liquidaciones')
    .upload(ruta, Buffer.from(bytes), { contentType: 'application/pdf', upsert: true });
  exigir(subida.error, `subir ${ruta}`);

  const { data, error } = await admin
    .from('liquidacion')
    .update({ pdf_url: ruta })
    .eq('tenant_id', TENANT_A)
    .eq('viaje_id', VIAJE_LIQUIDADO)
    .select('id');
  exigir(error, 'update liquidacion.pdf_url');
  if (!data?.length) {
    console.error('sembrar-e2e: no existe la liquidación de VJ-2026-0844 — ¿corrió el seed.sql?');
    process.exit(1);
  }
}

// ── 4. La declaración fiscal de Flota Demo — sin esto, el Resumen de la
//    dueña SIEMPRE rebota a /dashboard/onboarding (ver cabecera). ──────────
{
  const patch = {
    ingresosAnualesMxn: { valor: 20_000_000, procedencia: 'declarado' }, // 🔴 INVENTADO
    parteRelacionada: { valor: false, procedencia: 'declarado' },
  };
  const { error } = await admin
    .from('tenant')
    .update({ perfil: patch, perfil_actualizado_por: duenaUserId })
    .eq('id', TENANT_A);
  exigir(error, 'declarar perfil fiscal de Flota Demo');
}

// Cartera sintética: una propia y otra sin asignar nunca visible al vendedor.
{
  const { error } = await admin.from('prospecto').upsert([
    { id: 'eeeeeeee-0001-4000-8000-000000000001', empresa: 'Cartera propia E2E', vendedor_id: vendedorUserId, estado: 'nuevo', notas: null },
    { id: 'eeeeeeee-0001-4000-8000-000000000002', empresa: 'Cartera ajena E2E', vendedor_id: null, estado: 'nuevo', notas: null },
  ], { onConflict: 'id' });
  exigir(error, 'sembrar cartera sintética de vendedor');
}

console.log('sembrar-e2e: 6 usuarios (@likida.test), Flota E2E B, el PDF de VJ-2026-0844 y el perfil fiscal de Flota Demo listos.');
