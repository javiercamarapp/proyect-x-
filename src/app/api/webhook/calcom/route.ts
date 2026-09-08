// El handler vive en lib (ARQ-B1, auditoría 28): ver la cabecera de
// `src/lib/admin/calcom_webhook.ts` para el porqué. Esta ruta es solo la
// puerta HTTP — sesión/rol no aplican aquí, la puerta es la firma HMAC que
// el handler verifica.
import { procesarWebhookCalcom } from '@/lib/admin/calcom_webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = procesarWebhookCalcom;
