// ═══════════════════════════════════════════════════════════════════════════
// COMPLEMENTO — un viaje adicional al tenant `ZZZ QA MES DEMO` dedicado SOLO a
// demostrar limpiamente el camino `sobre_politica` (diesel $4,500 > tope
// $4,000). El viaje QAMES-144045 de la corrida principal iba a ser ese caso,
// pero dos de sus tres tickets cayeron en `wa.duplicate` porque compartían
// wa_message_id determinístico con una corrida de humo (`QA_MES_SMOKE=1`)
// anterior contra el MISMO tenant — el propio dedup (invariante #3) hizo su
// trabajo y los rechazó, dejando esa liquidación con solo el ticket de
// alimentación. Este archivo usa un folio nuevo (sin colisión posible) para
// que el ataque del tope se vea limpio, sin tocar los 20 viajes ya sembrados.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, test, beforeAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cargaEnvLocal, exigirClaves } from './config.qa';
import { instalarMetaFalso, generarTicketPng, enviarFoto, enviarTexto, drenarSalientes } from './agentes/operador.qa';

instalarMetaFalso();

const TENANT_ID = 'aaaaaaaa-0000-4000-8000-000000009902';
const TELEFONO = '5215559920001'; // chofer 1, ya sembrado por la corrida principal
const FOLIO = 'QAMES-TOPE-EXTRA';

let db: SupabaseClient;
let Op: typeof import('@/lib/likida/operacion');
let cuadreOraculo: typeof import('./oraculos/cuadre_balancea.oraculo');

describe('Complemento — demostración limpia de sobre_politica', () => {
  beforeAll(async () => {
    cargaEnvLocal();
    exigirClaves();
    db = (await import('@/lib/supabase/admin')).supabaseAdmin();
    Op = await import('@/lib/likida/operacion');
    cuadreOraculo = await import('./oraculos/cuadre_balancea.oraculo');
  }, 60_000);

  test('diesel $4,500 (tope $4,000) dispara sobre_politica y aun así cuadra', async () => {
    const { data: op } = await db.from('operador').select('id').eq('tenant_id', TENANT_ID).eq('telefono', TELEFONO).single();
    const { data: cli } = await db.from('cliente').select('id').eq('tenant_id', TENANT_ID).limit(1).single();
    const { data: unidad } = await db.from('unidad').select('id').eq('tenant_id', TENANT_ID).limit(1).single();

    const viajeId = await Op.crearViaje(TENANT_ID, {
      folio: FOLIO, origen: 'ZZZ Origen QA', destino: 'ZZZ Destino QA',
      fechaInicio: '2026-08-28', anticipo: 6000,
      operadorId: (op as { id: string }).id, unidadId: (unidad as { id: string })?.id ?? null,
      clienteId: (cli as { id: string })?.id ?? null, ingresoFlete: 9000, kmRecorridos: 300,
    });

    const dataUrl = await generarTicketPng({ monto: 4500, fecha: '2026-08-28', folio: 'DSL-TOPE-EXTRA', litros: 187.5 });
    await enviarFoto(TELEFONO, dataUrl, `${FOLIO}-diesel`);
    drenarSalientes();

    await enviarTexto(TELEFONO, 'listo', `${FOLIO}-cierre1`);
    let { data: liq } = await db.from('liquidacion').select('id').eq('tenant_id', TENANT_ID).eq('viaje_id', viajeId).maybeSingle();
    if (!liq) {
      await enviarTexto(TELEFONO, 'listo', `${FOLIO}-cierre2`);
      ({ data: liq } = await db.from('liquidacion').select('id').eq('tenant_id', TENANT_ID).eq('viaje_id', viajeId).maybeSingle());
    }
    console.log('LIQ_TRAS_SEGUNDO_CIERRE', liq ? liq.id : 'ninguna');
    drenarSalientes();

    const veredicto = await cuadreOraculo.oraculoCuadreBalancea(TENANT_ID, viajeId, {
      esperaLiquidacion: true,
      esperaSobrePolitica: { cuantas: 1, excesoTotal: 500 },
    });
    console.log('VEREDICTO_TOPE_EXTRA', JSON.stringify(veredicto));
  }, 300_000);
});
