import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../../.env.local');

if (!fs.existsSync(envPath)) {
  console.error("No se encontró .env.local en:", envPath);
  process.exit(1);
}

const envContent = fs.readFileSync(envPath, 'utf8');
let supabaseUrl = '';
let supabaseKey = '';

for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (trimmed.startsWith('NEXT_PUBLIC_SUPABASE_URL=')) {
    supabaseUrl = trimmed.slice('NEXT_PUBLIC_SUPABASE_URL='.length).replace(/["']/g, '').trim();
  }
  if (trimmed.startsWith('SUPABASE_SERVICE_ROLE_KEY=')) {
    supabaseKey = trimmed.slice('SUPABASE_SERVICE_ROLE_KEY='.length).replace(/["']/g, '').trim();
  }
}

if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(supabaseUrl)) {
  console.error('NEXT_PUBLIC_SUPABASE_URL no es un host de Supabase');
  process.exit(1);
}

const stagingDir = path.resolve(__dirname, '../../staging_canacar');
fs.mkdirSync(stagingDir, { recursive: true });

const stagingMdPath = path.join(stagingDir, 'staging_emails.md');
const stagingJsonPath = path.join(stagingDir, 'staging_emails.json');
const statePath = path.join(stagingDir, 'progress_state.json');
const lockDir = path.join(stagingDir, '.save_lock');

function withLock(fn) {
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (e) {
      const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(waitBuffer, 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.rmdirSync(lockDir); } catch (e) {}
  }
}


// Crea el archivo solo si no existe todavía — sin el hueco entre comprobar y
// escribir del patrón existsSync+writeFileSync (auditoría CodeQL: otro
// proceso pudo crearlo justo en medio, y el write lo pisaba con el estado
// inicial). 'wx' falla con EEXIST si ya está, y eso se ignora a propósito.
export function crearSiNoExiste(ruta, contenido) {
  try {
    fs.writeFileSync(ruta, contenido, { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}

crearSiNoExiste(stagingMdPath, '# Staging de Correos de Venta Likida — Padrón CANACAR\n\n');
crearSiNoExiste(stagingJsonPath, JSON.stringify({ total_correos: 0, correos: [] }, null, 2));
crearSiNoExiste(statePath, JSON.stringify({
  last_updated: new Date().toISOString(),
  total_processed: 0,
  encaje_si: 0,
  encaje_no: 0,
  encaje_dudoso: 0,
  total_emails_generated: 0,
  batches_completed: 0,
  processed_ids: []
}, null, 2));

export function getState() {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

export async function fetchUnprocessedCandidates(limitCount = 50) {
  const state = getState();
  const processedSet = new Set(state.processed_ids || []);

  let allRows = [];
  let offset = 0;
  const pageLimit = 1000;

  while (true) {
    const endpoint = `${supabaseUrl}/rest/v1/prospecto?notas=ilike.*CANACAR*&select=id,empresa,ciudad,correo,telefono,estado,notas,fuente&order=id.asc&offset=${offset}&limit=${pageLimit}`;
    const res = await fetch(endpoint, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      }
    });

    if (!res.ok) {
      console.error('Error al consultar Supabase:', res.status, await res.text());
      break;
    }

    const data = await res.json();
    allRows.push(...data);
    if (data.length < pageLimit) break;
    offset += pageLimit;
  }

  const seenEmails = new Set();
  const seenNames = new Set();

  for (const r of allRows) {
    const notas = r.notas || '';
    const email = (r.correo || '').trim().toLowerCase();
    const name = (r.empresa || '').trim().toLowerCase();

    const isDone = notas.toLowerCase().includes('lote 1/9') ||
                   notas.includes('INVESTIGACIÓN PROFUNDA CANACAR') ||
                   processedSet.has(r.id);

    if (isDone) {
      if (email) seenEmails.add(email);
      if (name) seenNames.add(name);
    }
  }

  let candidates = [];
  for (const r of allRows) {
    const notas = r.notas || '';
    if (notas.toLowerCase().includes('lote 1/9')) continue;
    if (notas.includes('INVESTIGACIÓN PROFUNDA CANACAR')) continue;
    if (processedSet.has(r.id)) continue;
    if (notas.includes('SIN MENSAJE') || notas.includes('aplica=false') || (r.fuente && r.fuente.includes('descarte'))) continue;

    const email = (r.correo || '').trim().toLowerCase();
    const name = (r.empresa || '').trim().toLowerCase();

    if (email && seenEmails.has(email)) continue;
    if (!email && name && seenNames.has(name)) continue;

    candidates.push(r);
  }

  function parseSizeScore(notas) {
    if (!notas) return 0;
    const text = notas.toLowerCase();
    if (/251\+|250\+|\b(?:más de 250|250 o más)\b/.test(text)) return 1000;
    if (/101\s*(?:a|-)\s*250/.test(text)) return 500;
    if (/51\s*(?:a|-)\s*250/.test(text)) return 400;
    if (/51\s*(?:a|-)\s*100/.test(text)) return 300;
    if (/31\s*(?:a|-)\s*50/.test(text)) return 200;
    if (/11\s*(?:a|-)\s*50/.test(text)) return 150;
    if (/11\s*(?:a|-)\s*30/.test(text)) return 100;
    if (/6\s*(?:a|-)\s*10/.test(text)) return 50;
    if (/0\s*(?:a|-)\s*10/.test(text)) return 30;
    return 0;
  }

  candidates.sort((a, b) => {
    const scoreA = parseSizeScore(a.notas);
    const scoreB = parseSizeScore(b.notas);
    if (scoreB !== scoreA) return scoreB - scoreA;
    const hasEmailA = a.correo && a.correo.trim() ? 1 : 0;
    const hasEmailB = b.correo && b.correo.trim() ? 1 : 0;
    if (hasEmailB !== hasEmailA) return hasEmailB - hasEmailA;
    return (a.empresa || '').localeCompare(b.empresa || '');
  });

  return candidates.slice(0, limitCount);
}

export async function saveCompanyResult(data) {
  if (!data.id) throw new Error('Falta el ID del prospecto');
  if (!/^[0-9a-f-]{36}$/i.test(data.id)) throw new Error('data.id no es uuid');
  const idFiltro = encodeURIComponent(data.id);

  // 1. Obtener notas actuales
  const getRes = await fetch(`${supabaseUrl}/rest/v1/prospecto?id=eq.${idFiltro}&select=id,notas`, {
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
    },
  });

  if (!getRes.ok) throw new Error(`Error al leer prospecto: ${getRes.status}`);
  const currentRows = await getRes.json();
  if (currentRows.length === 0) throw new Error(`Prospecto ${data.id} no encontrado`);

  const oldNotes = currentRows[0].notas || '';

  // 2. Formatear bloque
  const block = [
    `=== INVESTIGACIÓN PROFUNDA CANACAR ${data.fecha || '28-ago-2026'} (lote ${data.lote || 2}) ===`,
    `ENCAJE LIKIDA: ${data.encaje_likida}`,
    ``,
    `DIRECTOR: ${data.director_nombre || 'no encontrado'}`,
    `LINKEDIN EMPRESA: ${data.linkedin_empresa || 'no encontrado'}`,
    `LINKEDIN DIRECTOR: ${data.linkedin_director || 'no encontrado'}`,
    `FACEBOOK: ${data.facebook || 'no encontrado'}`,
    `AÑO FUNDACIÓN: ${data.anio_fundacion || 'no encontrado'}`,
    `HISTORIA: ${data.historia || 'no encontrado'}`,
    `EMPLEADOS: ${data.empleados_estimado || 'no encontrado'}`,
    `FLOTA: ${data.flota_estimada || 'no encontrado'}`,
    'ESTADO / PLAZA: ' + (data.estado_federativo || data.estado || data.ciudad || 'no encontrado'),
    'CEDIS / SUCURSALES / TERMINALES: ' + (data.cedis || data.sucursales || data.terminales || 'no encontrado'),
    'TODOS LOS CORREOS: ' + (data.todos_los_correos || data.correo || 'no encontrado'),
    `OTROS CONTACTOS: ${data.contactos_adicionales || 'no encontrado'}`,
    `NOTAS: ${data.notas || 'no encontrado'}`,
    ``,
    `Fuente: padrón CANACAR + investigación profunda ${data.fecha || '28-ago-2026'}, lote ${data.lote || 2} de investigación (Antigravity/Gemini 3.7).`
  ].join('\n');

  const hasDeepResearch = oldNotes.includes('=== INVESTIGACIÓN PROFUNDA CANACAR');
  const newNotes = hasDeepResearch ? oldNotes : (oldNotes ? `${oldNotes}\n\n${block}` : block);

  // 3. Update Supabase (prospecto + prospecto_persona + prospecto_correo)
  const patchPayload = { notas: newNotes };

  if (data.director_nombre && !data.director_nombre.toLowerCase().includes('no encontrado')) {
    patchPayload.contacto_nombre = data.director_nombre.trim();
  }

  if (data.historia && !data.historia.toLowerCase().includes('no encontrado')) {
    patchPayload.historia = data.historia.trim();
  }

  if (data.sitio || data.sitio_web) {
    const web = (data.sitio || data.sitio_web).trim();
    patchPayload.sitio = web;
    patchPayload.sitio_web = web;
    patchPayload.sitio_verificado = true;
  }

  let unitsNum = null;
  if (data.flota_estimada && !data.flota_estimada.toLowerCase().includes('no encontrado')) {
    const match = data.flota_estimada.match(/(\d+[\d,]*)/);
    if (match) {
      unitsNum = parseInt(match[1].replace(/,/g, ''), 10);
      if (!isNaN(unitsNum)) {
        patchPayload.num_unidades = unitsNum;
        if (unitsNum >= 250) patchPayload.unidades = '250+';
        else if (unitsNum >= 101) patchPayload.unidades = '101-250';
        else if (unitsNum >= 31) patchPayload.unidades = '31-100';
        else if (unitsNum >= 5) patchPayload.unidades = '5-30';
      }
    }
  }

  if (data.correo_venta && data.encaje_likida === 'SI') {
    patchPayload.mensaje_correo_asunto = 'Automatizar la liquidación de viajes, antes de contratar para el puesto';
    patchPayload.mensaje_correo = data.correo_venta.trim();
    patchPayload.mensajes_generados_en = new Date().toISOString();
    patchPayload.mensajes_modelo = 'Gemini 3.7 Flash';
  }

  const patchRes = await fetch(`${supabaseUrl}/rest/v1/prospecto?id=eq.${idFiltro}`, {
    method: 'PATCH',
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(patchPayload),
  });

  if (!patchRes.ok) throw new Error(`Error en PATCH Supabase: ${patchRes.status}`);

  // 3b. Guardar decisor en prospecto_persona
  if (data.director_nombre && !data.director_nombre.toLowerCase().includes('no encontrado')) {
    try {
      const origen = (data.linkedin_director && !data.linkedin_director.includes('no encontrado'))
        ? 'linkedin'
        : (data.sitio || data.sitio_web) ? 'sitio_empresa' : 'directorio';

      await fetch(`${supabaseUrl}/rest/v1/prospecto_persona`, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          prospecto_id: data.id,
          nombre: data.director_nombre.trim(),
          puesto: data.director_puesto || 'Director General',
          correo: data.director_correo || null,
          telefono: data.director_telefono || null,
          linkedin: (data.linkedin_director && !data.linkedin_director.includes('no encontrado')) ? data.linkedin_director.trim() : null,
          origen: origen,
          confianza: 'alta',
          evidencia: `Investigación web profunda CANACAR (${data.fecha || '28-ago-2026'})`
        })
      });
    } catch (e) {
      console.warn('Advertencia al insertar en prospecto_persona:', e.message);
    }
  }

  // 3c. Guardar todos los correos en prospecto_correo
  const allEmailsRaw = `${data.correo || ''} ${data.contactos_adicionales || ''} ${data.todos_los_correos || ''} ${data.notas || ''}`;
  const foundEmails = [...new Set((allEmailsRaw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []).map(e => e.toLowerCase()))];
  for (const em of foundEmails) {
    try {
      await fetch(`${supabaseUrl}/rest/v1/prospecto_correo`, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=ignore-duplicates,return=minimal',
        },
        body: JSON.stringify({
          prospecto_id: data.id,
          correo: em,
          fuente: 'investigacion_web'
        })
      });
    } catch {}
  }


  // 4 y 5. Archivos de staging y actualización de estado (con lock atómico)
  withLock(() => {
    const state = getState();
    state.processed_ids = state.processed_ids || [];
    const alreadyProcessed = state.processed_ids.includes(data.id);

    if (data.correo_venta && data.encaje_likida === 'SI' && !alreadyProcessed) {
      const jsonContent = JSON.parse(fs.readFileSync(stagingJsonPath, 'utf8'));
      jsonContent.total_correos = (jsonContent.total_correos || 0) + 1;
      jsonContent.correos.push({
        id: data.id,
        empresa: data.empresa,
        correo: data.correo,
        telefono: data.telefono,
        asunto: 'Automatizar la liquidación de viajes, antes de contratar para el puesto',
        cuerpo: data.correo_venta,
        generado_en: new Date().toISOString(),
      });
      fs.writeFileSync(stagingJsonPath, JSON.stringify(jsonContent, null, 2), 'utf8');

      const mdEntry = [
        `\n## ${jsonContent.total_correos}. ${data.empresa}`,
        `- **ID Prospecto:** \`${data.id}\``,
        `- **Destinatario:** \`${data.correo || 'sin correo'}\` | Tel: \`${data.telefono || 'sin teléfono'}\``,
        `- **Encaje Likida:** ${data.encaje_likida}`,
        `- **Asunto:** \`Automatizar la liquidación de viajes, antes de contratar para el puesto\``,
        ``,
        `\`\`\`text`,
        data.correo_venta.trim(),
        `\`\`\``,
        `\n---`
      ].join('\n');

      fs.appendFileSync(stagingMdPath, mdEntry, 'utf8');
    }

    if (alreadyProcessed) return;
    state.last_updated = new Date().toISOString();
    state.total_processed = (state.total_processed || 0) + 1;
    if (data.encaje_likida === 'SI') state.encaje_si = (state.encaje_si || 0) + 1;
    else if (data.encaje_likida === 'NO') state.encaje_no = (state.encaje_no || 0) + 1;
    else state.encaje_dudoso = (state.encaje_dudoso || 0) + 1;

    if (data.correo_venta && data.encaje_likida === 'SI') {
      state.total_emails_generated = (state.total_emails_generated || 0) + 1;
    }

    if (!state.processed_ids.includes(data.id)) {
      state.processed_ids.push(data.id);
    }
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  });

  console.log(`[OK] Guardado: ${data.empresa} (${data.id}) | Encaje: ${data.encaje_likida}`);
}

// CLI test
if (process.argv[2] === '--list') {
  const n = parseInt(process.argv[3] || '10', 10);
  fetchUnprocessedCandidates(n).then(c => {
    console.log(`Próximas ${c.length} empresas pendientes:`);
    console.log(JSON.stringify(c.map(x => ({ id: x.id, empresa: x.empresa, ciudad: x.ciudad, correo: x.correo })), null, 2));
  });
}
