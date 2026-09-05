// ═══════════════════════════════════════════════════════════════════════════
// AUD24 · PRU-A1 (ALTO, REINCIDENTE) — `route.ts:315-316` arma la respuesta
// JSON del formato SAP B1 DTW; la mutación M16 intercambia las dos claves
// (`oJournalEntries.txt` recibe `sap.lineas`, `JournalEntries_Lines.txt`
// recibe `sap.cabecera`) y ninguna prueba lo nota — `salida.test.ts` y
// `rol_dinero.test.ts` (los dos archivos que hoy tocan esta ruta) solo
// ejercitan `formato=contpaqi`.
//
// Mismo arnés que `salida.test.ts` (mocks de auth/catálogo/perfil/rpc), pero
// con un perfil `sap_b1` confirmado y `SAP_B1_BASE` REAL — cuyas dos filas
// técnicas son inconfundibles: `oJournalEntries.txt` trae `RefDate/DueDate/
// TaxDate` (cabecera del asiento) y `JournalEntries_Lines.txt` trae
// `Line_ID/Account/Debit/Credit` (renglones) — así que un intercambio se ve
// en el contenido, no solo en el nombre de la llave.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SAP_B1_BASE } from '@/lib/likida/contabilidad/formatos';

const resolverTenantApi = vi.fn(async () => ({
  ok: true as const, tenantId: 'tenant-1', rol: 'contador' as string,
}));
vi.mock('@/lib/auth/tenant-api', () => ({
  resolverTenantApi: (...a: unknown[]) => resolverTenantApi(...(a as [])),
}));
vi.mock('@/lib/ratelimit', () => ({ rateLimit: async () => true, clientIp: () => '203.0.113.7' }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const CATALOGO_COMPLETO = {
  gastos: { diesel: '5010-001', hospedaje: '5010-004' },
  ivaAcreditable: '1180-001',
  ivaNoAcreditable: '1180-002',
  gastoNoDeducible: '5990-001',
  gastoPorConfirmar: '5990-002',
  retencionesPorPagar: '2015-001',
  anticipoOperador: '1190-001',
  porCobrarOperador: '1190-002',
  porPagarOperador: '2010-001',
};

vi.mock('@/lib/likida/contabilidad/catalogo', async (orig) => ({
  ...(await orig<typeof import('@/lib/likida/contabilidad/catalogo')>()),
  catalogoDeclarado: async () => ({ ok: true, catalogo: CATALOGO_COMPLETO }),
}));
vi.mock('@/lib/likida/contabilidad/perfiles', () => ({
  perfilExportacionDeclarado: async () => ({
    sistema: 'sap_b1' as const,
    confirmadoEn: '2026-08-01T00:00:00.000Z',
    plantilla: SAP_B1_BASE,
  }),
}));

const filas = [{
  liquidacionId: 'l-1', folioViaje: 'VJ-1', operador: 'Juan', fecha: '2026-08-20',
  anticipo: 5000, comprobado: 3480, diferencia: 1520, ivaAcreditable: 480,
  porConcepto: [{ concepto: 'diesel', subtotal: 3000, baseConocida: true }],
  baseDesconocida: 0,
  // AUD24 (integración): la RPC 0281 (FIS-2/FIS-3) agregó `version` y los
  // campos por comprobante que `cubetaDe`/`aGasto` leen — sin ellos
  // `rpcDesactualizada` contesta 409 (`route.ts:104-110`), que es
  // exactamente lo que este archivo prueba que NO debe pasar aquí.
  version: 342, revision: 'aprobada',
  gastos: [{
    id: 'g1', concepto: 'diesel', subtotal: 3000, descuento: null, tieneCfdi: true,
    monto: 3000, fecha: '2026-08-20', cfdiUuid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    cfdiOrden: 1, folio: 'DS-1', folioNorm: 'DS1', formaPago: '01',
    pagadoEn: '2026-08-20', pagadoForma: '01', ivaRetenido: null, isrRetenido: null,
  }],
  diferencias: [],
  retenciones: 0,
}];
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ rpc: async () => ({ data: filas, error: null }) }),
}));
vi.mock('@/lib/likida/presupuesto', () => ({ acotada: async (p: unknown) => p }));

const { GET } = await import('./route');

const URL_SAP = 'https://app.likida.ai/api/export/poliza?desde=2026-08-01&hasta=2026-08-24&formato=sap_b1';

beforeEach(() => {
  resolverTenantApi.mockResolvedValue({ ok: true as const, tenantId: 'tenant-1', rol: 'contador' });
});

describe('PRU-A1: SAP B1 DTW — los dos archivos NO están intercambiados', () => {
  it('oJournalEntries.txt trae la CABECERA (RefDate/DueDate/TaxDate), no los renglones', async () => {
    const r = await GET(new Request(URL_SAP));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.formato).toBe('sap_b1_dtw');
    const cabecera = j.archivos['oJournalEntries.txt'] as string;
    expect(cabecera).toContain('RefDate');
    expect(cabecera).toContain('DueDate');
    expect(cabecera).not.toContain('Line_ID');
  });

  it('JournalEntries_Lines.txt trae los RENGLONES (Line_ID/Account/Debit/Credit), no la cabecera', async () => {
    const r = await GET(new Request(URL_SAP));
    const j = await r.json();
    const lineas = j.archivos['JournalEntries_Lines.txt'] as string;
    expect(lineas).toContain('Line_ID');
    expect(lineas).toContain('Account');
    expect(lineas).not.toContain('RefDate');
  });
});
