import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decidir, ultimaMigracion, prefijosMigraciones, ultimoConDeployEnAsunto } from './compuerta-deploy.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24 · OP-P1 / OP-P3 — la compuerta que ata `[deploy]` a las
// migraciones. Pura: asunto + última migración del repo + JSON del health.
// ═══════════════════════════════════════════════════════════════════════════

const sana = (base: string) => ({ ok: true, status: 'ok', migracion: { base, codigo: base, atras: 0 } });

describe('OP-P1: [deploy] con la base atrás NO construye, y dice qué aplicar', () => {
  it('base 0271, código 0276: bloquea con el rango 0272..0276', () => {
    const v = decidir({ asunto: 'fix(fiscal): póliza [deploy]', codigo: '0276', health: sana('0271') });
    expect(v.construir).toBe(false);
    expect(v.nivel).toBe('error');
    expect(v.motivo).toContain('faltan 5 migración(es) (0272..0276)');
  });

  it('atrás = 1 — el único caso que ocurre en la vida real (auditoría 25, PRU-MEDIO REINCIDENTE): bloquea igual', () => {
    const v = decidir({ asunto: 'chore: migración suelta [deploy]', codigo: '0304', health: sana('0303') });
    expect(v.construir).toBe(false);
    expect(v.nivel).toBe('error');
    expect(v.motivo).toContain('faltan 1 migración(es) (0304..0304)');
  });

  it('a la par: construye', () => {
    const v = decidir({ asunto: 'chore: algo [deploy]', codigo: '0276', health: sana('0276') });
    expect(v).toMatchObject({ construir: true, nivel: 'ok' });
  });

  it('la base por delante del código (rollback de código) también construye', () => {
    expect(decidir({ asunto: 'x [deploy]', codigo: '0275', health: sana('0276') }).construir).toBe(true);
  });

  it('sin [deploy] en el asunto no construye, y no es error (es el diseño del ignoreCommand)', () => {
    const v = decidir({ asunto: 'fix: menciona deploy en el cuerpo\n\n[deploy]', codigo: '0276', health: sana('0276') });
    expect(v).toMatchObject({ construir: false, nivel: 'ok' });
  });
});

describe('OP-P3: lo que no se pudo cotejar no es verde', () => {
  it('health caído: no construye', () => {
    const v = decidir({ asunto: 'x [deploy]', codigo: '0276', health: null });
    expect(v.construir).toBe(false);
    expect(v.motivo).toContain('[deploy:forzar]');
  });

  it('base ilegible (migraciones_aplicadas no contestó): no construye, con el motivo del health', () => {
    const v = decidir({ asunto: 'x [deploy]', codigo: '0276', health: { migracion: { base: null, codigo: '0276', atras: null, motivo: 'migraciones_aplicadas() no contestó: timeout' } } });
    expect(v.construir).toBe(false);
    expect(v.motivo).toContain('timeout');
  });

  it('health de la versión anterior (sin `migracion`): construye UNA vez con aviso — es el arranque de la compuerta', () => {
    const v = decidir({ asunto: 'x [deploy]', codigo: '0276', health: { ok: true, status: 'ok', version: 'abc1234' } });
    expect(v).toMatchObject({ construir: true, nivel: 'aviso' });
  });

  it('[deploy:forzar] salta la compuerta a la vista (aviso, no error)', () => {
    const v = decidir({ asunto: 'hotfix [deploy:forzar]', codigo: '0276', health: sana('0271') });
    expect(v).toMatchObject({ construir: true, nivel: 'aviso' });
    expect(v.motivo).toContain('bajo tu responsabilidad');
  });
});

// ARQUITECTURA 25 (MEDIO, REINCIDENTE) — el escenario exacto del reporte: una
// rama cortada abajo aterriza con `0295_*.sql` cuando producción ya está en
// `0303`. `codigo` (el máximo del repo) sigue en `0303` — 0295 no lo mueve —
// así que el cotejo por MÁXIMO (`base === codigo === '0303'`) sale verde con
// 0295 sin aplicar. El cotejo por CONJUNTO (`m.aplicados`) sí lo ve.
describe('ARQ-25: el cotejo por CONJUNTO ve el hueco que el cotejo por MÁXIMO no ve', () => {
  const prefijosCodigo = ['0271', '0295', '0303']; // el repo, con 0295 recién llegado
  const aplicadosSinElHueco = ['0271', '0303']; // la base: todo menos 0295

  it('SIN el conjunto (health de antes de esta ronda): máximo=máximo, construye — el bug', () => {
    const v = decidir({
      asunto: 'x [deploy]', codigo: '0303', prefijosCodigo,
      health: { migracion: { base: '0303', codigo: '0303', atras: 0 } }, // sin `aplicados`
    });
    expect(v.construir).toBe(true); // fail-open: publica con 0295 sin aplicar
  });

  it('CON el conjunto, bloquea y nombra el prefijo que falta (0295), no un rango', () => {
    const v = decidir({
      asunto: 'x [deploy]', codigo: '0303', prefijosCodigo,
      health: { migracion: { base: '0303', codigo: '0303', atras: 0, aplicados: aplicadosSinElHueco } },
    });
    expect(v.construir).toBe(false);
    expect(v.nivel).toBe('error');
    expect(v.motivo).toContain('0295');
  });

  it('CON el conjunto y la base completa, construye y lo dice', () => {
    const v = decidir({
      asunto: 'x [deploy]', codigo: '0303', prefijosCodigo,
      health: { migracion: { base: '0303', codigo: '0303', atras: 0, aplicados: prefijosCodigo } },
    });
    expect(v).toMatchObject({ construir: true, nivel: 'ok' });
    expect(v.motivo).toContain('CONJUNTO completo');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 25 · ALTO REINCIDENTE — el detector de deriva por schedule usaba
// `git log --grep`, que casa contra ASUNTO y CUERPO. Un merge commit cuyo
// asunto no lleva [deploy] pero cuyo cuerpo lo hereda del commit mergeado
// pasaba el filtro igual: el detector se anclaba en un commit que Vercel
// nunca pudo construir (`4f94490`, 3-sep-2026) y quedaba en rojo permanente.
//
// `decidir()` arriba SÍ implementaba bien "solo la primera línea" — el BAJO
// de la 25 señaló que la suite lo prueba (línea 29-32 de este archivo, la
// prueba "sin [deploy] en el asunto…") pero nunca ejercitaba la lógica
// REAL que usaba `salud-produccion.yml:134`, así que ninguna prueba podía
// reprobar exactamente lo que el sistema acababa de violar. Estas pruebas
// reproducen el escenario real con `ultimoConDeployEnAsunto` (la función que
// ahora reemplaza al `git log --grep` roto) y habrían fallado con la versión
// vieja (equivalente a un `--grep` sobre asunto+cuerpo).
// ═══════════════════════════════════════════════════════════════════════════
describe('OP-A (25, ALTO REINCIDENTE): el ancla de la deriva mira solo el ASUNTO, no el cuerpo', () => {
  it('un merge commit sin [deploy] en el asunto NO cuenta, aunque su cuerpo lo herede del commit mergeado — el escenario real de 4f94490', () => {
    const commits = [
      { sha: 'merge4f94490', asunto: 'Merge pull request #318 from javiercamarapp/deploy/trigger-chat-fix' },
      { sha: 'flag5a14012', asunto: '[deploy] promueve el fix del chat con tenant fantasma (PR #314) a producción' },
      { sha: 'anterior', asunto: 'chore: algo sin relación' },
    ];
    // El commit del merge (el más nuevo) NO lleva [deploy] en su asunto: se
    // salta, y el ancla cae en el commit de abajo que sí lo lleva.
    expect(ultimoConDeployEnAsunto(commits)).toBe('flag5a14012');
  });

  it('el commit efectivo real de la ronda 25: 3cc8ead, no 4f94490 ni 5a14012 (que nunca fue tip)', () => {
    const commits = [
      { sha: '4f94490', asunto: 'Merge pull request #318 from javiercamarapp/deploy/trigger-chat-fix' },
      { sha: '9d8fea4', asunto: 'chore: algo intermedio sin bandera' },
      { sha: '3cc8ead', asunto: '[deploy] docs: confirma migraciones 0272→0301 aplicadas' },
    ];
    expect(ultimoConDeployEnAsunto(commits)).toBe('3cc8ead');
  });

  it('ninguno lleva [deploy]: null, no una cadena vacía ni el HEAD por defecto', () => {
    expect(ultimoConDeployEnAsunto([{ sha: 'a', asunto: 'fix: x' }, { sha: 'b', asunto: 'chore: y' }])).toBeNull();
  });

  it('lista vacía: null, sin lanzar', () => {
    expect(ultimoConDeployEnAsunto([])).toBeNull();
  });

  it('usa la MISMA regex que decidir() — [deploy:forzar] también cuenta', () => {
    expect(ultimoConDeployEnAsunto([{ sha: 'x', asunto: 'hotfix [deploy:forzar]' }])).toBe('x');
  });
});

describe('el cableado', () => {
  it('ultimaMigracion lee el repo real y da el mismo prefijo que next.config.ts inlinea', () => {
    expect(ultimaMigracion()).toMatch(/^\d{4}$/);
  });

  it('prefijosMigraciones incluye el máximo que da ultimaMigracion', () => {
    const prefijos = prefijosMigraciones();
    expect(prefijos.at(-1)).toBe(ultimaMigracion());
  });

  it('vercel.json corre la compuerta y conserva la inversión de exit del ignoreCommand', () => {
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { ignoreCommand: string };
    expect(vercel.ignoreCommand).toBe('node scripts/ci/compuerta-deploy.mjs && exit 1 || exit 0');
  });

  it('salud-produccion.yml la corre en el push con [deploy] y coteja el último [deploy] por schedule', () => {
    const wf = readFileSync('.github/workflows/salud-produccion.yml', 'utf8');
    expect(wf).toContain('scripts/ci/compuerta-deploy.mjs');
    expect(wf).toContain("github.event_name != 'push'");
    expect(wf).toContain('issues: write');
  });

  // ═════════════════════════════════════════════════════════════════════════
  // AUDITORÍA 27 · OP-C2 (CRÍTICO) — LA ALARMA QUE SE CIERRA SOLA.
  //
  // El paso que detecta la deriva («Producción corre el último [deploy] de
  // master») está condicionado a `github.event_name != 'push'`: en un push NO
  // se evalúa. El paso que CIERRA el issue estaba condicionado a `success()`
  // a secas, sin mirar el evento. Resultado: una corrida por push que jamás
  // comprobó la deriva certificaba la recuperación y cerraba el issue que una
  // corrida por schedule había abierto por deriva.
  //
  // Medido contra la API de GitHub el 6-sep-2026, no inferido:
  //   #339 abierto 04:53:03Z (schedule en rojo) → cerrado 11:01:53Z por la
  //        corrida de push 34029045759 (11:01:45Z) sobre 06b2eca4, cuyo asunto
  //        no lleva [deploy] y que por tanto nunca evaluó la deriva.
  //   #334 abierto 00:06:12Z → cerrado 00:30:25Z, mismo patrón.
  //   #325 abierto 04-sep 09:46:43Z → cerrado 05-sep 23:08:41Z, ídem.
  // Con 20 corridas por schedule en rojo seguidas y producción 224 commits
  // atrás, la etiqueta `salud-produccion` no tenía UN SOLO issue abierto.
  //
  // El invariante: **cerrar exige haber evaluado**. Solo puede declarar la
  // recuperación una corrida que sí corrió la comprobación de deriva, y esa
  // es exactamente la que cumple `github.event_name != 'push'`.
  // ═════════════════════════════════════════════════════════════════════════
  it('OP-C2: el issue solo lo cierra una corrida que SÍ evaluó la deriva, nunca un push', () => {
    const wf = readFileSync('.github/workflows/salud-produccion.yml', 'utf8');
    // El bloque del paso que cierra: desde su `name` hasta el siguiente `- name:`.
    const cierre = wf.split('- name: Cerrar el issue al recuperarse')[1]?.split('\n      - name:')[0];
    expect(cierre, 'no existe el paso «Cerrar el issue al recuperarse»').toBeTruthy();
    const condicion = /^\s*if:\s*(.+)$/m.exec(cierre!)?.[1]?.trim();
    expect(condicion, 'el paso que cierra el issue no declara `if:`').toBeTruthy();
    // `success()` a secas es el defecto: certifica un job que pudo no haber
    // mirado la deriva. La condición tiene que excluir el push explícitamente.
    expect(condicion).toContain("github.event_name != 'push'");
  });

  it('el cotejo por schedule usa ultimo-deploy-en-asunto.mjs, no git log --grep (asunto+cuerpo)', () => {
    const wf = readFileSync('.github/workflows/salud-produccion.yml', 'utf8');
    expect(wf).toContain('scripts/ci/ultimo-deploy-en-asunto.mjs');
    // La invocación rota era exactamente esta forma (`--grep` sobre git log,
    // que casa asunto+cuerpo); el comentario que explica el porqué del
    // cambio SÍ puede seguir mencionando "--grep" en prosa.
    expect(wf).not.toContain("git log -i --grep");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // OP-A2 (auditoría 28, ALTO) — el pulso declara `cron: '*/30 * * * *'` pero
  // la propia auditoría lo midió corriendo ~8 veces al día, con huecos de
  // hasta 5h30. Nada en el repo medía la cadencia real del propio workflow.
  // Este `it` exige que el pulso se mida a sí mismo y avise (no que decida)
  // cuando se degrade — solo en schedule/workflow_dispatch, nunca en push.
  // ═════════════════════════════════════════════════════════════════════════
  it('OP-A2: el pulso mide su propia cadencia y avisa (::warning::) cuando se degrada, con permiso para leerse', () => {
    const wf = readFileSync('.github/workflows/salud-produccion.yml', 'utf8');
    expect(wf).toContain('actions: read');
    expect(wf).toContain('contents: read');
    expect(wf).toContain('issues: write');
    expect(wf).toContain('gh run list');
    expect(wf).toMatch(/salud-produccion\.yml/);
    expect(wf).toContain('::warning::');
    // El paso de cadencia no corre en push (ahí no hay "corrida programada
    // anterior" que medir de la misma forma, y OP-C2 ya fija que push no
    // evalúa invariantes de deriva).
    expect(wf).toMatch(/github\.event_name\s*!=\s*'push'/);
  });
});
