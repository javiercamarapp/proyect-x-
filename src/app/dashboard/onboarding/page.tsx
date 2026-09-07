import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { resolverTenantEfectivo } from '@/lib/auth/tenant-efectivo';
import { puedeVerRuta } from '@/lib/auth/visibilidad';
import { CONECTORES } from '@/lib/likida/conectores/registro';
import type { CategoriaConector } from '@/lib/likida/conectores/tipos';
import {
  onboardingFiscalListo, umbralPeajeDeclarado, stackDeclarado,
  declararOnboarding, facilidad15Declarada,
} from '@/lib/likida/perfil/preguntas';
import { parseOnboarding } from '@/lib/likida/perfil/onboarding';
import { getPerfilCrudo, guardarPerfilPatch, actualizarFacilidad15 } from '@/lib/likida/repo';
import { subirPoliticaPerfil } from '@/lib/likida/perfil/documentos';
import { mensajeParaPantalla } from '@/lib/likida/administracion';
import { sufijoTenant } from '../sufijo';
import { FormaOnboarding, type Opcion } from './forma';
import { ChatEntrevista } from './chat';
import { estadoEntrevista, mensajeBienvenida } from '@/lib/likida/perfil/entrevista';
import type { ResultadoAccion } from '../../admin/ui/forma';

export const dynamic = 'force-dynamic';

const EXTRA: Opcion[] = [
  { valor: '', texto: 'Elige una' },
  { valor: 'ninguno', texto: 'No usamos' },
];
const OTRO: Opcion = { valor: 'otro', texto: 'Otro (escríbelo abajo)' };

function opciones(cat: CategoriaConector): Opcion[] {
  return [
    ...EXTRA,
    ...CONECTORES.filter((c) => c.categoria === cat).map((c) => ({ valor: c.id, texto: c.nombre })),
    OTRO,
  ];
}

export default async function OnboardingFlotaPage({
  searchParams,
}: {
  searchParams: Promise<{ vista?: string; tenant?: string; rol?: string }>;
}) {
  const sp = await searchParams;
  const s = await resolverTenantEfectivo('/dashboard/onboarding', sp);
  if (!puedeVerRuta(s.rol, '/dashboard/onboarding')) redirect('/dashboard');
  const sufijo = sufijoTenant(sp);

  let perfil: unknown = {};
  try { perfil = await getPerfilCrudo(s.tenantId); } catch { perfil = {}; }
  const umbral = umbralPeajeDeclarado(perfil);
  const stack = stackDeclarado(perfil);

  async function accion(_prev: ResultadoAccion, fd: FormData): Promise<ResultadoAccion> {
    'use server';
    const ses = await resolverTenantEfectivo('/dashboard/onboarding', sp);
    if (!puedeVerRuta(ses.rol, '/dashboard/onboarding')) {
      return { error: 'Tu rol no puede declarar el perfil de la flota.' };
    }
    const parsed = parseOnboarding(fd);
    if (!parsed.ok) return { error: parsed.error };

    const archivo = fd.get('politica');
    try {
      if (archivo instanceof File && archivo.size > 0) {
        parsed.datos.politicaDocumento = await subirPoliticaPerfil(ses.tenantId, archivo);
      }
      const patch = declararOnboarding(parsed.datos);
      await guardarPerfilPatch(ses.tenantId, patch, ses.userId);
      const f15 = facilidad15Declarada(patch);
      if (f15) {
        await actualizarFacilidad15(ses.tenantId, f15.dedicacionExclusivaCarga, f15.regimenElegible, ses.userId);
      }
    } catch (e) {
      return { error: mensajeParaPantalla(e, 'guardar el perfil') };
    }
    revalidatePath('/dashboard');
    revalidatePath('/dashboard/onboarding');
    revalidatePath('/dashboard/contador');
    redirect(`/dashboard${sufijoTenant(sp)}`);
  }

  const gps = opciones('Rastreo GPS');
  const erp = opciones('ERP y contabilidad');
  const tag = opciones('Peaje y monederos').filter((o) => o.valor !== 'monedero_diesel' && o.valor !== 'powergas');
  const monedero = [
    ...EXTRA,
    ...CONECTORES.filter((c) => c.id === 'monedero_diesel' || c.id === 'powergas')
      .map((c) => ({ valor: c.id, texto: c.nombre })),
    OTRO,
  ];

  const entrevista = estadoEntrevista(perfil);
  const bien = mensajeBienvenida(entrevista);
  const preguntaInicial = entrevista.siguiente?.pregunta ?? null;
  const formulario = (
    <details className="text-left">
      <summary className="text-[12.5px] cursor-pointer text-center" style={{ color: 'var(--faint)' }}>
        Prefiero el formulario
      </summary>
      <p className="text-[11px] mt-2 mb-4" style={{ color: 'var(--muted)' }}>
        Las mismas declaraciones, sin conversación. Vacío no se inventa como no.
        Los topes de gasto se capturan en{' '}
        <a href={`/dashboard/politicas${sufijo}`} className="underline">Políticas</a>.
      </p>
      <FormaOnboarding
        accion={accion}
        gps={gps} erp={erp} tag={tag} monedero={monedero}
        inicial={{
          ingresos: umbral.ingresosMenoresA300M === null ? '' : umbral.ingresosMenoresA300M ? 'menor' : 'mayor',
          parte: umbral.parteRelacionada === null ? '' : umbral.parteRelacionada ? 'si' : 'no',
          gps: stack.gps ?? '',
          erp: stack.erp ?? '',
          tag: stack.tag ?? '',
          monedero: stack.monedero ?? '',
          pagoOperador: stack.pagoOperador ?? '',
        }}
      />
    </details>
  );

  return (
    <main className="h-full">
      <div className="rounded-2xl min-h-full hairline flex flex-col" style={{ background: 'var(--g1)' }}>
        <div className="flex-1 flex flex-col">
          <ChatEntrevista
            preguntaInicial={preguntaInicial}
            chipsIniciales={bien.chips}
            sustentoInicial={bien.sustento}
            perfilListoInicial={entrevista.perfilListo || onboardingFiscalListo(perfil)}
            sufijo={sufijo}
            formulario={formulario}
          />
        </div>
      </div>
    </main>
  );
}
