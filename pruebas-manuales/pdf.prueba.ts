// ═══════════════════════════════════════════════════════════════════════════
// ARNÉS MANUAL — el PDF de liquidación, MIRÁNDOLO.
//
// Un test que solo comprueba que la función no truena no dice nada de un
// documento. Este genera el PDF real con muchos comprobantes (para forzar el
// corte de página) y lo deja en disco para abrirlo y verlo.
//
//   npx vitest run --config pruebas-manuales/vitest.config.ts pruebas-manuales/pdf.prueba.ts
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Liquidacion, Viaje, Operador, Gasto } from '@/types/likida';

test('PDF con 25 comprobantes: anuncia lo que no cupo y trae el descargo', async () => {
  const { generarLiquidacionPDF } = await import('@/lib/likida/liquidacion/pdf');

  const gastos: Gasto[] = Array.from({ length: 25 }, (_, i) => ({
    id: `g${i}`,
    concepto: i % 3 === 0 ? 'diesel' : i % 3 === 1 ? 'caseta' : 'alimentacion',
    monto: 100 + i * 7,
    folio: `F${1000 + i}`,
    fecha: '2026-05-01',
  }));
  const total = gastos.reduce((s, g) => s + g.monto, 0);

  const liq: Liquidacion = {
    id: 'liq-1', viajeId: 'v1', totalComprobado: total, totalAnticipo: total + 500,
    diferencia: 500, estatus: 'revisar', gastos,
    diferencias: [
      { tipo: 'sin_cfdi', concepto: 'diesel', monto: 0, nota: 'Diésel de $340 requiere factura CFDI y no trae UUID válido.', gastoId: 'g3' },
      { tipo: 'viatico_excede_fiscal', concepto: 'alimentacion', monto: 150, nota: 'Alimentación del 2026-05-01: $900 (3 comprobantes del día) excede el tope fiscal de $750 por día (LISR 28-V).', gastoId: 'g5' },
    ],
    totalDeducible: total - 150 - 1200, totalNoDeducible: 150, totalPorConfirmar: 1200,
    litrosDieselAcreditables: 255,
    iepsAcreditable: 320.5, ivaAcreditable: 210.75, peajeAcreditable: 480,
    creadaEn: '2026-07-27T12:00:00.000Z',
  };
  const viaje: Viaje = { id: 'v1', folio: 'VJ-0042', demoraNoImputable: true, origen: 'Mérida', destino: 'Cancún' } as Viaje;
  const operador: Operador = { id: 'o1', nombre: 'Juan Pérez', terminal: 'Mérida' } as Operador;

  const bytes = await generarLiquidacionPDF(liq, viaje, operador, 'TRANSPORTES DEL SURESTE SA DE CV');
  // Nombre fijo en /tmp compartido = objetivo de symlink por otro usuario del
  // sistema (CodeQL: Insecure temporary file). Un directorio temporal propio
  // y exclusivo del proceso lo cierra.
  const dir = mkdtempSync(join(tmpdir(), 'likida-pdf-'));
  const ruta = join(dir, 'liquidacion-prueba.pdf');
  writeFileSync(ruta, bytes, { mode: 0o600 });

  console.log(`\n📄 PDF escrito en: ${ruta}`);
  console.log(`   ${gastos.length} comprobantes, total ${total}`);
  console.log(`   Ábrelo y comprueba: (1) el renglón "… y N comprobantes más",`);
  console.log(`   (2) que los renglones impresos + ese renglón cuadren con el total,`);
  console.log(`   (3) el descargo del art. 52 del CFF al pie.\n`);

  expect(bytes.length).toBeGreaterThan(1000);
}, 120_000);
