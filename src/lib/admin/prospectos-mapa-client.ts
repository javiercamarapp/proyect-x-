// Contrato compartido por componentes cliente. Este módulo debe permanecer
// libre de Supabase, Node y cualquier otra dependencia server-only.

export const COLOR_EMBUDO: Record<string, { color: string; nombre: string }> = {
  nuevo: { color: '#64748b', nombre: 'Sin contactar' },
  contactado: { color: '#d97706', nombre: 'Contactado' },
  demo: { color: '#7c3aed', nombre: 'Demo dado' },
  negociacion: { color: '#ea580c', nombre: 'En negociación' },
  cerrado: { color: '#16a34a', nombre: 'Cliente' },
  perdido: { color: '#94a3b8', nombre: 'Perdido' },
  appointment: { color: '#2563eb', nombre: 'Cita agendada' },
  rescheduled: { color: '#0891b2', nombre: 'Cita reprogramada' },
  cancelled: { color: '#be123c', nombre: 'Cita cancelada' },
  'no-show': { color: '#9f1239', nombre: 'No se presentó' },
  proposal: { color: '#c026d3', nombre: 'Propuesta' },
  pilot: { color: '#0f766e', nombre: 'Piloto' },
  won: { color: '#15803d', nombre: 'Ganado' },
  lost: { color: '#64748b', nombre: 'Perdido' },
};

/** Incluye aliases históricos para que la UI no ofrezca redacción en filas
 * previas a la migración del embudo. */
export function esProspectoTerminal(estado: string): boolean {
  return estado === 'won' || estado === 'cerrado'
    || estado === 'lost' || estado === 'perdido';
}

export type Giro =
  | 'transportista' | 'embotelladora' | 'abarrotes_mayoreo'
  | 'flota_propia' | 'logistica' | 'otro';

export const NOMBRE_GIRO: Record<Giro, string> = {
  transportista: 'Transportista',
  embotelladora: 'Embotelladora',
  abarrotes_mayoreo: 'Abarrotes / Mayoreo',
  flota_propia: 'Flota propia',
  logistica: 'Logística',
  otro: 'Otro giro',
};

export const TAMANOS = ['11-30', '31-50', '51-100', '101-250', '250+'] as const;
export type Tamano = (typeof TAMANOS)[number];

export const CRITERIO_SCORES = {
  urgencia: 'Urgencia = lo que él DECLARA manda sobre lo que inferimos: si contestó «ya, este mes nos está costando» en /getdemo vale 100, y si contestó «estoy explorando» queda con techo aunque su vacante grite. Sin declaración se infiere: la vacante que nombra la liquidación (+45), cuántos anuncios (+4 c/u, tope 20), qué tan reciente el último (+20 si es de hoy) y la ficha trabajada (+15). Estimación determinista, no medición.',
  cierre: 'Cierre = alcanzabilidad (tel +20, correo +15, decisor +20, +10 por decisor con contacto VERIFICADO —el inferido no cuenta—), quién llegó a quién (landing/campaña +20, anuncio pagado +25), fit del giro (transportista +15), tamaño de flota (+4 a +12 sin mezclarlo con urgencia), etapa del embudo (cita +18 … piloto +40; cliente ganado=100, perdido=0) y ficha a mano (+10). Estimación determinista, no medición: esto ORDENA la cola, no predice el cierre.',
  datos: 'Datos = qué tan completo está el expediente para salir a venderle: teléfono +30, correo +25, decisor +20, ubicación +15, sitio web VERIFICADO +10. El tamaño (11-30 … 250+) es el personal ocupado que reporta la DENUE.',
  similitud: 'Similitud con el ICP (0140, GENERADA — nadie la escribe a mano) = SCIAN de transporte objetivo (prefijo 484/485/488, aunque llegue en 6 dígitos) +40, vacante publicada +25, flota investigada ≥10 unidades +20, sitio web verificado +15.',
  necesidad: 'Necesidad (0140, GENERADA) = vacante de liquidación/cuadre/auxiliar administrativo +50 (cualquier otra vacante +25), flota investigada ≥20 unidades +25.',
} as const;

export interface ProspectoMapa {
  id: string;
  empresa: string;
  ciudad: string | null;
  entidad: string | null;
  lat: number | null;
  lng: number | null;
  telefono: string | null;
  correo: string | null;
  contacto: string | null;
  vacante: string | null;
  estado: string;
  fuente: string;
  giro: Giro;
  urgencia: number;
  cierre: number;
  tamano: Tamano | null;
  completitud: number;
  ultimoToque: string | null;
  mensajesGeneradosEn: string | null;
  numUnidades: number | null;
  similitudIcpPct: number;
  necesidadPct: number;
}

export interface TextosProspecto {
  id: string;
  notas: string | null;
  mensajeWaIa: string | null;
  correoAsuntoIa: string | null;
  correoCuerpoIa: string | null;
}

export type FilaCompacta = [
  id: string, empresa: string, ciudad: string | null, entidad: string | null,
  lat: number | null, lng: number | null, telefono: string | null,
  correo: string | null, contacto: string | null, vacante: string | null,
  estado: string, fuente: string, giro: Giro, urgencia: number, cierre: number,
  tamano: Tamano | null, completitud: number, ultimoToque: string | null,
  mensajesGeneradosEn: string | null, numUnidades: number | null,
  similitudIcpPct: number, necesidadPct: number,
];

export function desempacar(f: FilaCompacta): ProspectoMapa {
  const [
    id, empresa, ciudad, entidad, lat, lng, telefono, correo, contacto, vacante,
    estado, fuente, giro, urgencia, cierre, tamano, completitud, ultimoToque,
    mensajesGeneradosEn, numUnidades, similitudIcpPct, necesidadPct,
  ] = f;
  return {
    id, empresa, ciudad, entidad, lat, lng, telefono, correo, contacto, vacante,
    estado, fuente, giro, urgencia, cierre, tamano, completitud, ultimoToque,
    mensajesGeneradosEn, numUnidades, similitudIcpPct, necesidadPct,
  };
}

export interface DatosMapa {
  filas: FilaCompacta[];
  generadoEn: string;
  fallo: boolean;
  marca: string | null;
  delta: boolean;
  total: number | null;
}

export interface PersonaProspecto {
  id: string;
  nombre: string;
  puesto: string | null;
  correo: string | null;
  telefono: string | null;
  linkedin: string | null;
  origen: string;
  confianza: 'alta' | 'media' | 'baja';
  evidencia: string | null;
}

export interface DetalleProspecto extends ProspectoMapa, TextosProspecto {
  sitio: string | null;
  sitioVerificado: boolean;
  historia: string | null;
  viajesMesEstimado: number | null;
  fuenteCruda: string;
  creadoEn: string;
  personas: PersonaProspecto[];
}
