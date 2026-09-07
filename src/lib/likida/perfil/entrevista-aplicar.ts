import { guardarPerfilPatch, actualizarFacilidad15, getPerfilCrudo } from '../repo';
import { guardarConfigCobranza, leerConfigCobranza } from '../agentes/cobranza';
import { crearOperador, guardarPolitica } from '../administracion';
import { crearUnidad } from '../operacion';
import { guardarDatosFiscales, REGIMENES } from '@/lib/saas/fiscal';
import { getConfig } from '../config';
import { logger } from '@/lib/logger';
import {
  declararHechos, declararAusente, facilidad15Declarada, type DatosOnboarding,
} from './preguntas';
import {
  interpretarTurno, estadoEntrevista, mensajeConfirmacion, mensajeBienvenida,
  CATALOGO_POR_ID, chipsDe, textoPregunta, type CampoEntrevista,
} from './entrevista';

export interface ResultadoTurno {
  texto: string;
  chips: { valor: string; etiqueta: string }[];
  perfilListo: boolean;
  elegiblePeaje: boolean | null;
  guardado: boolean;
}

export type PasoEntrevista = { fase: 'inicio' | 'fin'; tool: string };

export async function aplicarTurnoEntrevista(opts: {
  tenantId: string;
  userId: string | null;
  perfilCrudo: unknown;
  texto: string;
  onPaso?: (p: PasoEntrevista) => void;
}): Promise<ResultadoTurno> {
  const marcar = async <T,>(tool: string, fn: () => T | Promise<T>): Promise<T> => {
    opts.onPaso?.({ fase: 'inicio', tool });
    try { return await fn(); }
    finally { opts.onPaso?.({ fase: 'fin', tool }); }
  };

  const { hechos, noSe, ambiguo, preguntaDeTurno } = await marcar('interpretar_respuesta', () =>
    interpretarTurno(opts.perfilCrudo, opts.texto));

  const skip: CampoEntrevista[] = [];
  for (const id of noSe) {
    const p = CATALOGO_POR_ID[id];
    if (p?.requeridaParaPanel) {
      return {
        texto: `Esto no se puede dejar pendiente: ${p.pregunta}\n\nSustento: ${p.sustento.cita}. ${p.sustento.texto}\n\nSi no lo tienes a la mano, consúltalo y vuelve — no voy a adivinarlo.`,
        chips: p.chips.filter((c) => c.valor !== 'no_se'),
        perfilListo: false,
        elegiblePeaje: null,
        guardado: false,
      };
    }
    skip.push(id);
  }

  if (Object.keys(hechos).length === 0 && skip.length === 0) {
    const estado = estadoEntrevista(opts.perfilCrudo);
    const bien = mensajeBienvenida(estado);
    return {
      texto: ambiguo
        ? `${ambiguo}\n\n${preguntaDeTurno ? textoPregunta(preguntaDeTurno) : bien.texto}`
        : (preguntaDeTurno
          ? `No entendí esa respuesta y prefiero no suponerla.\n\n${textoPregunta(preguntaDeTurno)}`
          : bien.texto),
      chips: preguntaDeTurno?.chips ?? bien.chips,
      perfilListo: estado.perfilListo,
      elegiblePeaje: estado.elegiblePeaje,
      guardado: false,
    };
  }

  const patch = {
    ...declararHechos(hechos as Partial<DatosOnboarding>),
    ...(skip.length ? declararAusente(skip) : {}),
  };
  const perfilNuevo = await marcar('guardar_perfil', async () => {
    await guardarPerfilPatch(opts.tenantId, patch, opts.userId);
    const leido = await getPerfilCrudo(opts.tenantId);
    const f15 = facilidad15Declarada(leido);
    if (f15) {
      await actualizarFacilidad15(opts.tenantId, f15.dedicacionExclusivaCarga, f15.regimenElegible, opts.userId);
    }
    if (hechos.cobranzaVentana) {
      const actual = await leerConfigCobranza(opts.tenantId);
      await guardarConfigCobranza(opts.tenantId, { ...actual, ...hechos.cobranzaVentana });
    }
    return leido;
  });

  const extras = await marcar('nutrir_operacion', () =>
    nutrirDesdeHechos(opts.tenantId, hechos, perfilNuevo, opts.userId));

  const estado = estadoEntrevista(perfilNuevo);
  const texto = await marcar('armar_respuesta', () => [
    skip.length ? 'Quedó pendiente (no se inventó un no).' : '',
    extras.length ? extras.join('\n') : '',
    Object.keys(hechos).length ? mensajeConfirmacion(hechos, estado) : (estado.siguiente
      ? `\n${textoPregunta(estado.siguiente)}`
      : 'No queda nada pendiente de declarar.'),
  ].filter(Boolean).join('\n'));

  return {
    texto,
    chips: chipsDe(estado),
    perfilListo: estado.perfilListo,
    elegiblePeaje: estado.elegiblePeaje,
    guardado: true,
  };
}

function declarado<T>(perfil: unknown, k: string): T | undefined {
  if (!perfil || typeof perfil !== 'object') return undefined;
  const c = (perfil as Record<string, unknown>)[k];
  if (!c || typeof c !== 'object') return undefined;
  const o = c as { valor?: T; procedencia?: string };
  if (o.procedencia !== 'declarado' && o.procedencia !== 'detectado') return undefined;
  return o.valor;
}

/** Escribe en las tablas vivas lo que el chat ya declaró: receptor CFDI,
 *  operadores, unidades, política. Nunca inventa un dato que no vino. */
async function nutrirDesdeHechos(
  tenantId: string,
  hechos: Partial<DatosOnboarding>,
  perfil: unknown,
  userId: string | null,
): Promise<string[]> {
  const notas: string[] = [];
  const actor = userId ? { id: userId } : undefined;
  const rfc = hechos.rfcEmpresa ?? declarado<string>(perfil, 'rfcEmpresa');
  const razon = hechos.razonSocial ?? declarado<string>(perfil, 'razonSocial');
  const regimen = hechos.regimenSat ?? declarado<string>(perfil, 'regimenSat');
  const cp = hechos.codigoPostalFiscal ?? declarado<string>(perfil, 'codigoPostalFiscal');
  const email = hechos.emailFacturacion ?? declarado<string>(perfil, 'emailFacturacion');
  const clavesOk = new Set(REGIMENES.map((r) => r.clave));

  if (rfc && razon && regimen && cp && clavesOk.has(regimen as typeof REGIMENES[number]['clave'])) {
    try {
      await guardarDatosFiscales(tenantId, {
        rfc, razonSocial: razon, regimenFiscal: regimen, codigoPostal: cp,
        usoCfdi: 'G03', email,
      });
      notas.push('Los cinco datos del receptor CFDI 4.0 ya están en la flota (uso G03).');
    } catch (e) {
      // OPERABILIDAD-19C2-6: sin este log, un fallo de escritura fiscal
      // durante el onboarding era invisible para observabilidad — solo
      // quedaba la nota que el chofer/dueño ve en el chat, sin tenantId ni
      // rastro en logs para diagnosticar por qué falló.
      logger.error('entrevista.fiscal', { tenantId, err: e instanceof Error ? e.message : String(e) });
      notas.push(e instanceof Error ? e.message : 'No pude guardar los datos fiscales.');
    }
  }

  if (hechos.topesPolitica) {
    try {
      const t = hechos.topesPolitica;
      const cfg = await getConfig(tenantId);
      const porRuta = cfg.politica.filter((p) => p.ruta);
      const tope = (concepto: string, n: number | undefined) =>
        n != null ? { concepto, topeMonto: n } : cfg.politica.find((p) => p.concepto === concepto && !p.ruta);
      const politica = [
        tope('diesel', t.diesel),
        tope('caseta', t.caseta),
        tope('alimentacion', t.alimentacion),
        tope('hospedaje', t.hospedaje),
        ...cfg.politica.filter((p) => !p.ruta && !['diesel', 'caseta', 'alimentacion', 'hospedaje'].includes(p.concepto)),
        ...porRuta,
      ].filter((p): p is NonNullable<typeof p> => !!p);
      await guardarPolitica(tenantId, politica, actor);
      notas.push('Topes de flota escritos en Políticas (no son ley).');
    } catch (e) {
      logger.warn('entrevista.politica', { err: e instanceof Error ? e.message : String(e) });
      notas.push('No pude escribir los topes: se quedan en el perfil para cargarlos en Políticas.');
    }
  }

  for (const o of hechos.operadoresAlta ?? []) {
    try {
      await crearOperador(tenantId, { nombre: o.nombre, telefono: o.telefono }, actor);
      notas.push(`Operador listo para WhatsApp: ${o.nombre}.`);
    } catch (e) {
      logger.error('entrevista.operador_alta', { tenantId, err: e instanceof Error ? e.message : String(e) });
      notas.push(e instanceof Error ? e.message : `No pude dar de alta a ${o.nombre}.`);
    }
  }

  for (const u of hechos.unidadesAlta ?? []) {
    try {
      await crearUnidad(tenantId, { numeroEconomico: u.economico, placas: u.placas ?? null });
      notas.push(`Unidad ${u.economico} dada de alta.`);
    } catch (e) {
      logger.error('entrevista.unidad_alta', { tenantId, err: e instanceof Error ? e.message : String(e) });
      notas.push(e instanceof Error ? `Unidad ${u.economico}: ${e.message}` : `No pude dar de alta ${u.economico}.`);
    }
  }

  return notas;
}
